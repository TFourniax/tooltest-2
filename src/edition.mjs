export const LOCAL_EDITION = Object.freeze({
  id:'local',
  label:'IdleProof Local',
  delivery:'self-hosted-local',
  sourcePolicy:'source-stays-local',
  capabilities:Object.freeze({
    liveExplain:true,
    currentSession:true,
    currentFeatureMap:true,
    optionalUnderstandingCheck:true,
    localEvidence:true,
    longitudinalHistory:false,
    knowledgeDebtHistory:false,
    projectMemoryDashboard:false,
    spacedRecallHistory:false,
    multiProject:false,
    multiDevice:false,
    teamVisibility:false,
    hostedSync:false
  })
});

export const PORTAL_CAPABILITIES = Object.freeze({
  longitudinalHistory:true,
  knowledgeDebtHistory:true,
  projectMemoryDashboard:true,
  spacedRecallHistory:true,
  multiProject:true,
  multiDevice:true,
  teamVisibility:true,
  hostedSync:true
});

export function localEdition() {
  return { ...LOCAL_EDITION, capabilities:{ ...LOCAL_EDITION.capabilities } };
}
