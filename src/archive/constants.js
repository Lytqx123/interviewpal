// 轮次固定三面：一面简历面 / 二面业务面 / 三面终面（方案书 §5.4）。
// 以后要加 HR 面之类的轮次，往这个数组里加 key 就行，不用动 store。
export const ROUND_KEYS = ['round1', 'round2', 'round3'];

// 岗位类型，来自方案书 §5.4 的"岗位类型驱动考察引擎"。
// tech 技术岗 / product 产品 / operation 运营 / sales 市场销售 / function 职能 / civil 公考考编
export const JOB_TYPES = ['tech', 'product', 'operation', 'sales', 'function', 'civil'];

// 复盘六维评分（§4.1）：逻辑结构 / 内容相关性 / 专业深度 / 表达流畅度 / 互动质量 / 自信心态
export const SCORE_DIMENSIONS = ['logic', 'relevance', 'depth', 'fluency', 'interaction', 'confidence'];

// 困难点分类（§5.9）：未回答上来 / 答偏跑题 / 沉默超时 / 回答浅薄
export const DIFFICULTY_CATEGORIES = ['noAnswer', 'offTopic', 'silence', 'shallow'];

// 检索缓存的默认过期时间：
//   stable   一面相关的公司/技术信息，可以放久一点
//   volatile 二面三面要强时效，面试前一天会刷新（§5.3）
export const CACHE_TTL_MS = {
  stable: 7 * 24 * 60 * 60 * 1000,
  volatile: 24 * 60 * 60 * 1000,
};
