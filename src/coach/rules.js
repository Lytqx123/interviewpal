// 复盘教练规则兜底：无 LLM 时也能生成六维评分、改进清单、困难题、下次重点。
// 评分基于候选人回答的文本特征启发式（结构词/关键词覆盖/长度/填充词/反问/犹豫词）。
// BARS 行为锚定评分标准（联网调研）：每一分值附带行为证据，避免描述空心化。

// 六维 BARS 评分标准（1/3/5 分锚点），供规则兜底和 LLM prompt 共用
export const SCORE_RUBRIC = {
  logic: {
    name: '逻辑结构',
    anchors: {
      1: '表述零散，无框架，因果断裂',
      3: '能按要素展开，存在少量跳跃',
      5: '先总后分，因果闭环，量化结果',
    },
  },
  relevance: {
    name: '内容相关性',
    anchors: {
      1: '跑题，未回应核心问题',
      3: '基本切题，覆盖主要点',
      5: '切中核心意图，有深度延展',
    },
  },
  depth: {
    name: '专业深度',
    anchors: {
      1: '停留在表面，无技术细节',
      3: '能展开方案，有基本深度',
      5: '深入原理，有量化数据与创新案例',
    },
  },
  fluency: {
    name: '表达流畅度',
    anchors: {
      1: '卡顿严重，填充词密集',
      3: '基本流畅，少量填充词',
      5: '表达精准，节奏把控好',
    },
  },
  interaction: {
    name: '互动质量',
    anchors: {
      1: '问答考试，无主动延展',
      3: '有主动思考，偶尔延展',
      5: '展示思考过程，推动对话',
    },
  },
  confidence: {
    name: '自信心态',
    anchors: {
      1: '犹豫密集，语气不坚定',
      3: '基本自信，少量犹豫',
      5: '高度自信，对不确定也能展示推理框架',
    },
  },
};

// 结构词（逻辑性检测）
const STRUCTURE_WORDS = ['首先', '其次', '然后', '最后', '因为', '所以', '因此', '导致', '结果', '综上', '另外', '此外'];
// 填充词（流畅度检测）
export const FILLER_WORDS = ['嗯', '啊', '那个', '就是', '其实'];
// 犹豫词（自信度检测）
const HESITATION_WORDS = ['可能', '大概', '不确定', '不太清楚', '也许', '应该', '好像', '似乎', '估计'];
// 反问标志（互动质量检测）
const INTERACTION_MARKS = ['？', '?', '请问', '想了解', '想问', '请教'];

function extractAnswers(turns) {
  return (turns ?? []).filter((t) => t.role === 'candidate').map((t) => t.content);
}

function extractQuestions(turns) {
  return (turns ?? []).filter((t) => t.role === 'interviewer').map((t) => t.content);
}

function countMatches(text, words) {
  return words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
}

// 从面试官问题提取关键词（中文连续 2+ 字符）。
// 按问题逐个提取、每问取前 5 个非停用词，避免开场白垄断关键词名额。
function extractKeywords(questions) {
  const stopWords = new Set(['你好', '我是', '今天的', '面试官', '我们', '可以', '讲讲', '说说', '能具体', '好的', '应聘', '岗位', '简历', '先简单', '做个', '自我介绍', '重点', '聊聊', '你的', '经历', '看过', '申请', '感兴趣', '能讲讲', '假设', '让你', '这件事', '你会', '怎么', '什么', '遇到', '比如', '哪些', '考虑', '提到', '写了']);
  const keywords = new Set();
  for (const q of questions) {
    const matches = q.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
    matches.filter((m) => !stopWords.has(m)).slice(0, 5).forEach((m) => keywords.add(m));
  }
  return [...keywords];
}

// 2-gram（2 字滑动窗口）重叠率：衡量回答与问题的相关性。
// 比关键词匹配更稳健——中文无分词时，2-gram 能捕捉"订单""系统"等话题词重叠。
function bigramOverlap(textA, textB) {
  function bigrams(text) {
    const chars = text.match(/[\u4e00-\u9fa5]/g) ?? [];
    const grams = new Set();
    for (let i = 0; i < chars.length - 1; i++) grams.add(chars[i] + chars[i + 1]);
    return grams;
  }
  const ga = bigrams(textA);
  const gb = bigrams(textB);
  if (gb.size === 0) return 1;
  let overlap = 0;
  for (const g of gb) if (ga.has(g)) overlap++;
  return overlap / gb.size;
}

// 规则兜底：六维评分
export function scoreByRules(session) {
  const answers = extractAnswers(session.turns);
  const questions = extractQuestions(session.turns);
  const allAnswers = answers.join(' ');
  const avgLen = answers.length ? allAnswers.length / answers.length : 0;

  const structureCount = countMatches(allAnswers, STRUCTURE_WORDS);
  const logic = structureCount >= 3 ? 4 : structureCount >= 1 ? 3 : 2;

  const coverage = bigramOverlap(allAnswers, questions.join(' '));
  const relevance = coverage > 0.35 ? 4 : coverage > 0.18 ? 3 : 2;

  const hasNumbers = /\d+/.test(allAnswers);
  const depth = avgLen > 80 && hasNumbers ? 4 : avgLen > 30 ? 3 : 2;

  const fillerCount = countMatches(allAnswers, FILLER_WORDS);
  const fluency = fillerCount >= 3 ? 2 : fillerCount >= 1 ? 3 : 4;

  const interactionCount = countMatches(allAnswers, INTERACTION_MARKS);
  const interaction = interactionCount >= 2 ? 4 : interactionCount >= 1 ? 3 : 2;

  const hesitationCount = countMatches(allAnswers, HESITATION_WORDS);
  const confidence = hesitationCount >= 3 ? 2 : hesitationCount >= 1 ? 3 : 4;

  const scores = { logic, relevance, depth, fluency, interaction, confidence };
  const scoreEvidence = {
    logic: `检测到 ${structureCount} 个结构词`,
    relevance: `2-gram 重叠率 ${Math.round(coverage * 100)}%`,
    depth: `平均回答长度 ${Math.round(avgLen)} 字${hasNumbers ? '，含量化数据' : ''}`,
    fluency: `检测到 ${fillerCount} 个填充词`,
    interaction: `检测到 ${interactionCount} 个反问标志`,
    confidence: `检测到 ${hesitationCount} 个犹豫词`,
  };
  return { scores, scoreEvidence };
}

// 规则兜底：改进清单（低分高优先级、中分中优先级、高分巩固）
export function improvementByRules(scores) {
  const list = [];
  for (const [dim, score] of Object.entries(scores)) {
    const name = SCORE_RUBRIC[dim].name;
    if (score < 3) {
      list.push({ dimension: dim, name, priority: 'high', current: score, target: 4, suggestion: IMPROVEMENT_TEMPLATES[dim].low });
    } else if (score === 3) {
      list.push({ dimension: dim, name, priority: 'medium', current: score, target: 4, suggestion: IMPROVEMENT_TEMPLATES[dim].mid });
    } else {
      list.push({ dimension: dim, name, priority: 'maintain', current: score, target: score, suggestion: IMPROVEMENT_TEMPLATES[dim].high });
    }
  }
  return list;
}

const IMPROVEMENT_TEMPLATES = {
  logic: {
    low: '回答缺少逻辑框架，建议用"总-分-总"结构：先给结论，再展开要点，最后量化结果。',
    mid: '逻辑基本清晰但偶有跳跃，练习用"首先/其次/最后"显式标注结构，确保因果闭环。',
    high: '逻辑结构是优势，继续保持先总后分的表达习惯。',
  },
  relevance: {
    low: '存在跑题，回答前先复述面试官的核心问题，确保每句话都指向问题意图。',
    mid: '基本切题但覆盖不全，建议听题时记下关键词，回答时逐一覆盖。',
    high: '相关性是优势，继续保持精准切题的习惯。',
  },
  depth: {
    low: '回答偏浅，缺少技术细节。建议用 STAR 方法展开，补充量化数据和底层原理。',
    mid: '有一定深度但不够，练习追问"为什么"，把方案讲到底层原理和 trade-off。',
    high: '专业深度是优势，继续保持量化数据和原理深挖。',
  },
  fluency: {
    low: '填充词过多，建议录音回听，刻意减少"嗯/那个/就是"，用停顿代替填充。',
    mid: '基本流畅但仍有填充词，练习慢速表达，用呼吸停顿替代口头填充。',
    high: '表达流畅是优势，继续保持自然节奏。',
  },
  interaction: {
    low: '把面试当问答考试，建议主动延展思路，适时反问面试官，展示思考过程。',
    mid: '互动偏被动，练习在回答末尾加一句主动延展或澄清性反问。',
    high: '互动质量是优势，继续保持主动对话的姿态。',
  },
  confidence: {
    low: '犹豫词较多，建议对不确定的问题也展示推理框架，而非直接说"不知道"。',
    mid: '基本自信但有犹豫，练习用"我的理解是…因为…"替代"可能/大概"。',
    high: '自信心态是优势，继续保持从容应对。',
  },
};

// 规则兜底：方向偏差检测
export function directionDeviationByRules(session) {
  const expected = (session.turns ?? [])
    .filter((t) => t.role === 'interviewer' && t.focusArea)
    .map((t) => t.focusArea);
  return { expected, actual: [], notes: '规则路径无法精确推断实际方向，建议接入 LLM 补充' };
}

// 规则兜底：困难题识别
// 配对：answers[i] 回答的是 questions[i]（Q0→A0→Q1→A1...），故困难题取 questions[i]。
export function difficultQuestionsByRules(session) {
  const answers = extractAnswers(session.turns);
  const questions = extractQuestions(session.turns);
  const difficult = [];
  answers.forEach((ans, i) => {
    if (!ans || ans.length < 10) {
      difficult.push({ question: questions[i] ?? '', category: 'noAnswer', notes: '回答过短或未作答' });
    } else if (countMatches(ans, HESITATION_WORDS) >= 2) {
      difficult.push({ question: questions[i] ?? '', category: 'shallow', notes: '回答含较多犹豫词，可能理解不深' });
    }
  });
  return difficult;
}

// 规则兜底：逐题点评（遍历每个 Q&A 对，给质量分 + 失分标签 + 点评）。
// 联网调研标准（interview-debrief 4.2 问题全景）：每题评 1-5 分 + 失分原因标签 + 是否被追问。
// 失分标签沿用行业惯例：答非所问 / 无结构 / 表达问题 / 知识缺失 / 深挖崩盘。
export function perQuestionReviewByRules(session) {
  const turns = session.turns ?? [];
  const reviews = [];
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role !== 'interviewer') continue;
    const question = turns[i].content;
    // 配对该问题的回答：紧接的下一个 candidate turn
    const answerTurn = turns[i + 1]?.role === 'candidate' ? turns[i + 1] : null;
    const answer = answerTurn?.content ?? '';
    // 是否被追问：回答之后还有面试官问题（启发式，足以驱动点评）
    const followedUp = turns.slice(i + 2).some((t) => t.role === 'interviewer');

    const { score, weaknessTags, commentary } = assessAnswer(question, answer);
    reviews.push({
      turnNo: turns[i].turnNo ?? i + 1,
      focusArea: turns[i].focusArea ?? null,
      question,
      answer: answer.slice(0, 120),
      score,
      followedUp,
      weaknessTags,
      commentary,
    });
  }
  return reviews;
}

// 单题评估：基于回答文本特征给分 + 失分标签 + 点评
function assessAnswer(question, answer) {
  // 过短或未作答：直接 1 分，标"答非所问"
  if (!answer || answer.length < 10) {
    return {
      score: 1,
      weaknessTags: ['答非所问'],
      commentary: '回答过短或未作答。即使不确定也建议展示推理框架，而非沉默或一句话带过。',
    };
  }
  const weaknessTags = [];
  const overlap = bigramOverlap(answer, question); // 与本题的相关性
  const structureCount = countMatches(answer, STRUCTURE_WORDS);
  const fillerCount = countMatches(answer, FILLER_WORDS);
  const hesitationCount = countMatches(answer, HESITATION_WORDS);
  const hasNumbers = /\d+/.test(answer);

  if (overlap < 0.08) weaknessTags.push('答非所问');
  if (structureCount === 0) weaknessTags.push('无结构');
  if (fillerCount >= 2) weaknessTags.push('表达问题');
  if (hesitationCount >= 2) weaknessTags.push('知识缺失');
  if (answer.length < 30 || (!hasNumbers && answer.length < 60)) weaknessTags.push('深挖崩盘');

  // 评分：失分标签越多分越低；高质量（长+量化+有结构+切题）给 5
  const tagCount = weaknessTags.length;
  let score;
  if (tagCount === 0 && answer.length > 80 && hasNumbers && structureCount >= 2) score = 5;
  else if (tagCount === 0 && (answer.length > 60 || structureCount >= 1)) score = 4;
  else if (tagCount <= 2) score = 3;
  else if (tagCount <= 3) score = 2;
  else score = 1;

  return { score, weaknessTags, commentary: buildPerQuestionCommentary(score, weaknessTags) };
}

function buildPerQuestionCommentary(score, weaknessTags) {
  if (score >= 5) return '回答结构完整、切题且有量化支撑，保持这样的表达水准。';
  if (score === 4) return '回答基本到位，可补充量化数据或底层原理进一步提升深度。';
  const tags = weaknessTags.length ? `主要问题：${weaknessTags.join('、')}。` : '';
  if (score === 3) return `${tags}方向正确但不够扎实，建议补充结构词与具体数据。`;
  if (score === 2) return `${tags}回答存在明显短板，建议针对性补强后再练。`;
  return `${tags}回答质量较低，建议重新组织思路并对照标准答案重练。`;
}

// 规则兜底：下次重点
export function nextFocusByRules(scores) {
  const lowDims = Object.entries(scores).filter(([, s]) => s < 3).map(([d]) => SCORE_RUBRIC[d].name);
  if (lowDims.length) return lowDims.map((d) => `重点强化${d}`);
  const midDims = Object.entries(scores).filter(([, s]) => s === 3).map(([d]) => SCORE_RUBRIC[d].name);
  return midDims.length ? midDims.map((d) => `继续提升${d}`) : ['保持当前水平，挑战更高难度问题'];
}

// ============ 记忆闭环（方案书 §5.7：跨场次对比） ============
// 联网调研依据：Learning Loop（反思巩固学习）、三层复盘法第二层"跨多次练习趋势对比"、
// nowcoder"某类问题反复出现/某环节总翻车，闭环了才叫复盘"。
// 以下纯函数不依赖档案库，便于单测；由 memory.js 编排层串联。

// 提取 session 中的面试官问题（供重复题对比与档案库存储）
export function extractSessionQuestions(session) {
  return (session.turns ?? [])
    .filter((t) => t.role === 'interviewer')
    .map((t) => ({
      turnNo: t.turnNo ?? null,
      content: t.content,
      focusArea: t.focusArea ?? null,
    }));
}

// 重复题对比：用 2-gram 相似度判断当前问题是否在上次也问过（阈值 0.4）。
// 输出 { repeated, repeatedCount, newCount, total }，repeated 含配对与相似度。
export function compareRepeatedQuestions(currentQuestions, lastQuestions) {
  const cur = currentQuestions ?? [];
  const last = lastQuestions ?? [];
  const repeated = [];
  for (const c of cur) {
    let best = null;
    for (const l of last) {
      const sim = bigramOverlap(c.content ?? '', l.content ?? '');
      if (!best || sim > best.similarity) best = { last: l, similarity: sim };
    }
    if (best && best.similarity >= 0.4) {
      repeated.push({
        current: c.content,
        last: best.last.content,
        similarity: Math.round(best.similarity * 100) / 100,
      });
    }
  }
  return {
    repeated,
    repeatedCount: repeated.length,
    newCount: cur.length - repeated.length,
    total: cur.length,
  };
}

// 改进项完成率：上次需要改进的维度（high/medium 优先级），这次是否达到 target。
// 输出 { total, completed, rate, details }，details 逐项含 lastScore/target/currentScore/completed。
export function improvementCompletionRate(currentScores, lastImprovementList) {
  const targets = (lastImprovementList ?? []).filter(
    (i) => i.priority === 'high' || i.priority === 'medium',
  );
  if (!targets.length) return { total: 0, completed: 0, rate: 1, details: [] };
  const details = targets.map((t) => {
    const dim = t.dimension;
    const target = t.target ?? 4;
    const current = currentScores[dim] ?? 0;
    return {
      dimension: dim,
      name: t.name ?? SCORE_RUBRIC[dim]?.name ?? dim,
      lastScore: t.current ?? null,
      target,
      currentScore: current,
      completed: current >= target,
    };
  });
  const completed = details.filter((d) => d.completed).length;
  return { total: targets.length, completed, rate: completed / targets.length, details };
}

// 困难题标注是否上次也卡壳：2-gram 相似度匹配上次困难题（阈值 0.4）。
// 输出在原困难题上加 alsoStuckLastTime + matchedLastQuestion。
export function markAlsoStuckLastTime(currentDifficult, lastDifficult) {
  const last = lastDifficult ?? [];
  return (currentDifficult ?? []).map((q) => {
    let matched = null;
    for (const l of last) {
      const sim = bigramOverlap(q.question ?? '', l.question ?? '');
      if (sim >= 0.4) { matched = l; break; }
    }
    return {
      ...q,
      alsoStuckLastTime: !!matched,
      matchedLastQuestion: matched?.question ?? null,
    };
  });
}

// 可勾选改进清单：每项加 checked=false；与困难题相关的维度标 priorityRepractice=true。
// 困难题 category → 维度映射：noAnswer/offTopic→relevance，silence→confidence，shallow→depth。
const DIFFICULT_CATEGORY_TO_DIM = {
  noAnswer: 'relevance',
  offTopic: 'relevance',
  silence: 'confidence',
  shallow: 'depth',
};

export function makeCheckable(improvementList, difficultQuestions) {
  const difficultDims = new Set();
  for (const q of difficultQuestions ?? []) {
    const dim = DIFFICULT_CATEGORY_TO_DIM[q.category];
    if (dim) difficultDims.add(dim);
  }
  return (improvementList ?? []).map((item) => ({
    ...item,
    checked: false,
    priorityRepractice: difficultDims.has(item.dimension),
  }));
}
