import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { detectCommand, helpText } from '../src/feishu/commands.js';
import { createMessageHandler } from '../src/feishu/handler.js';
import { ArchiveStore } from '../src/archive/store.js';
import { createSearchProvider } from '../src/search/provider.js';

function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-feishu-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new ArchiveStore(dir);
}

test('命令识别：文件消息 / 文本命令 / 未知', () => {
  assert.equal(detectCommand({ messageType: 'file', fileName: '我的简历.pdf' }).intent, 'upload_resume');
  assert.equal(detectCommand({ messageType: 'text', text: '上传简历' }).intent, 'upload_resume');
  assert.equal(detectCommand({ messageType: 'text', text: '粘贴 JD：后端工程师岗位...' }).intent, 'paste_jd');
  assert.equal(detectCommand({ messageType: 'text', text: '你好' }).intent, 'unknown');
});

test('命令识别：大小写和 JD 写法', () => {
  assert.equal(detectCommand({ text: 'Upload Resume' }).intent, 'upload_resume');
  assert.equal(detectCommand({ text: '帮我贴 JD' }).intent, 'paste_jd');
});

test('handler：上传简历文本 → 解析并回复', async (t) => {
  const store = tmpStore(t);
  const handler = createMessageHandler({ store, llm: null, search: createSearchProvider({ provider: 'mock' }) });
  const reply = await handler({
    messageType: 'text',
    text: '上传简历',
    content: '张三，熟悉 Java、Redis。2020 年在字节跳动担任后端工程师，负责订单系统。',
  });
  assert.ok(reply.text.includes('简历已解析'));
  assert.ok(store.getResumeProfile());
});

test('handler：粘贴 JD → 自动建公司 + 岗位画像', async (t) => {
  const store = tmpStore(t);
  const handler = createMessageHandler({ store, llm: null, search: createSearchProvider({ provider: 'mock' }) });
  const jdText = `岗位名称：后端工程师
公司：星辰科技
岗位职责：
- 负责订单系统开发
任职要求：
- 熟悉 Java`;
  const reply = await handler({ messageType: 'text', text: '粘贴 JD', content: jdText });
  assert.ok(reply.text.includes('JD 已解析'));
  const company = store.findCompanyByName('星辰科技');
  assert.ok(company);
  const positions = store.listPositions(company.companyId);
  assert.equal(positions.length, 1);
  assert.equal(positions[0].jobType, 'tech');
  assert.ok(positions[0].profile.responsibilities.length > 0);
  // JD 补全结果落在 round2 缓存（二面业务面）
  assert.ok(store.getCache(company.companyId, 'round2').entries.length > 0);
});

test('handler：未知命令返回帮助', async (t) => {
  const store = tmpStore(t);
  const handler = createMessageHandler({ store });
  const reply = await handler({ messageType: 'text', text: '在吗' });
  assert.ok(reply.text.includes('支持的命令'));
  assert.ok(helpText().includes('上传简历'));
});

test('handler：缺内容时的提示', async (t) => {
  const store = tmpStore(t);
  const handler = createMessageHandler({ store });
  const reply = await handler({ messageType: 'text', text: '上传简历' });
  assert.ok(reply.text.includes('请把简历文件发给我'));
});
