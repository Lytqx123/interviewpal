// 预分析缓存读写（方案书 §5.4）。
// 键 = `resumeVersionId::companyId::positionId`；删除公司/岗位时由 store 联动释放。

export function strategyCacheKey({ resumeVersion, companyId, positionId }) {
  const versionId =
    typeof resumeVersion === 'string' ? resumeVersion : resumeVersion?.versionId;
  if (!versionId || !companyId || !positionId) {
    throw new Error('strategy cache key requires resumeVersion + companyId + positionId');
  }
  return `${versionId}::${companyId}::${positionId}`;
}

export function readStrategyCache(store, key) {
  return store?.getStrategyCache(key) ?? null;
}

export function writeStrategyCache(store, key, plan) {
  if (store) store.setStrategyCache(key, plan);
  return plan;
}
