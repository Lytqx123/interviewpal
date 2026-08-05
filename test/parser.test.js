import test from 'node:test';
import assert from 'node:assert/strict';

import { parseResumeByRules, parseJdByRules, detectJobType, extractSkills, extractCompanies } from '../src/parser/rules.js';
import { parseResume } from '../src/parser/resume.js';
import { parseJd } from '../src/parser/jd.js';
import { parseJsonFromText } from '../src/llm/provider.js';

const SAMPLE_RESUME = `张三
5 年 Java 后端开发经验

2019-2023 在字节跳动担任后端工程师，负责订单系统核心模块，把下单接口 QPS 从 500 提升到 2000
2023-2025 在蚂蚁集团任职高级工程师，参与支付链路重构

熟悉 Redis、Kafka、Spring Cloud、MySQL
掌握分布式事务、幂等设计`;

test('规则解析：简历提取技能/公司/经历', () => {
  const profile = parseResumeByRules(SAMPLE_RESUME);
  assert.ok(profile.skills.some((s) => s.name === 'Redis'));
  assert.ok(profile.skills.some((s) => s.name === '分布式事务'));
  assert.ok(profile.companies.includes('字节跳动'));
  assert.ok(profile.companies.includes('蚂蚁集团'));
  assert.equal(profile.experiences.length, 2);
  assert.ok(profile.rawHash.length > 0);
});

test('规则解析：JD 提取岗位/公司/职责/要求', () => {
  const jd = `岗位名称：后端工程师
公司：星辰科技
岗位职责：
- 负责订单系统的设计与开发
- 参与系统性能优化
任职要求：
- 熟悉 Java、Spring Boot
- 有 3 年以上后端经验`;
  const parsed = parseJdByRules(jd);
  assert.equal(parsed.title, '后端工程师');
  assert.equal(parsed.companyName, '星辰科技');
  assert.equal(parsed.jobType, 'tech');
  assert.ok(parsed.responsibilities.includes('负责订单系统的设计与开发'));
  assert.ok(parsed.requirements.some((r) => r.includes('Java')));
});

test('岗位类型识别：产品 / 运营 / 考公', () => {
  assert.equal(detectJobType('负责需求分析、PRD 撰写、用户研究'), 'product');
  assert.equal(detectJobType('负责用户运营、活动策划与增长'), 'operation');
  assert.equal(detectJobType('参加结构化面试，准备申论'), 'civil');
});

test('LLM 路径：围栏包裹的 JSON 也能解析并归一化', async () => {
  const fakeLlm = async () =>
    '```json\n' +
    JSON.stringify({
      basics: { name: '张三', title: '后端工程师' },
      companies: ['字节跳动'],
      skills: [{ name: 'Go', level: '熟悉' }],
      experiences: [{ summary: '在字节跳动负责订单系统', org: '字节跳动' }],
    }) +
    '\n```';
  const profile = await parseResume(SAMPLE_RESUME, { llm: fakeLlm });
  assert.equal(profile.basics.name, '张三');
  assert.equal(profile.skills[0].name, 'Go');
  assert.equal(profile.experiences[0].org, '字节跳动');
});

test('LLM 返回垃圾时自动落回规则', async () => {
  const badLlm = async () => '抱歉，我什么也没看懂';
  const profile = await parseResume(SAMPLE_RESUME, { llm: badLlm });
  assert.ok(profile.skills.length > 0); // 走的是规则路径
});

test('parseJsonFromText 容错', () => {
  assert.deepEqual(parseJsonFromText('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonFromText('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(parseJsonFromText('前缀 {"a":3} 后缀'), { a: 3 });
  assert.equal(parseJsonFromText('没有 json'), null);
});

test('JD 解析走 LLM 路径', async () => {
  const fakeLlm = async () =>
    JSON.stringify({
      companyName: '星辰科技',
      title: '产品经理',
      jobType: 'product',
      responsibilities: ['负责需求分析'],
      requirements: ['3 年产品经验'],
      keywords: ['需求分析'],
    });
  const parsed = await parseJd('随便一段 JD 文本', { llm: fakeLlm });
  assert.equal(parsed.jobType, 'product');
  assert.ok(parsed.responsibilities.includes('负责需求分析'));
});

test('extractSkills / extractCompanies 基本行为', () => {
  assert.ok(extractSkills('熟悉 Vue，掌握 React').includes('Vue'));
  assert.deepEqual(extractCompanies('2020 年在腾讯工作'), ['腾讯']);
});
