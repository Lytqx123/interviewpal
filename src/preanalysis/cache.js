// 预分析缓存读写（方案书 §5.4）。
// 键 = `resumeVersionId::companyId::positionId`；删除公司/岗位时由 store 联动释放。

export function preanalysisCacheKey({ resumeVersion, companyId, positionId }) {
  const versionId =
    typeof resumeVersion === 'string' ? resumeVersion : resumeVersion?.versionId;
  if (!versionId || !companyId || !positionId) {
    throw new Error('preanalysis cache key requires resumeVersion + companyId + positionId');
  }
  return `${versionId}::${companyId}::${positionId}`;
}

export function readPreanalysisCache(store, key) {
  return store?.getPreanalysisCache(key) ?? null;
}

export function writePreanalysisCache(store, key, plan) {
  if (store) store.setPreanalysisCache(key, plan);
  return plan;
}
