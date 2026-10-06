// Narrow, read-only tenant view for outcome/learning aggregation. Explicit
// foreign scope is never relabelled as this workspace's financial evidence.
const object=value=>value && typeof value==='object' && !Array.isArray(value);
export function evidenceInWorkspace(record, workspaceId) {
  if (!object(record) || typeof workspaceId!=='string' || !workspaceId || workspaceId!==workspaceId.trim() || workspaceId.length>256 || /[\u0000-\u001f\u007f]/.test(workspaceId)) return false;
  const values=['workspaceId','workspace_id','tenantId','tenant_id'].filter(key=>Object.hasOwn(record,key)).map(key=>record[key]);
  for(const key of ['workspace','tenant']) if(Object.hasOwn(record,key)) values.push(object(record[key]) ? record[key].id : record[key]);
  return values.every(value=>typeof value==='string' && value===workspaceId);
}
export function tenantBusinessEvidence(state={}) {
  const id=state.workspace?.id, owned=record=>evidenceInWorkspace(record,id);
  const rootOwned=owned(state) && owned(state.workspace);
  const array=value=>Array.isArray(value)?value:[];
  let ambiguousSourceRecordsExcluded=0;
  const uniqueSources=items=>{const counts=new Map(); for(const row of items) if(typeof row.id==='string') counts.set(row.id,(counts.get(row.id)||0)+1); return items.filter(row=>{const keep=typeof row.id!=='string'||counts.get(row.id)===1;if(!keep)ambiguousSourceRecordsExcluded++;return keep;});};
  const nested=(row,keys)=>keys.every(key=>row[key]===undefined || row[key]===null || owned(row[key]));
  const workRecords=rootOwned?uniqueSources(array(state.workRecords).filter(owned)).map(row=>({...row,evidence:array(row.evidence).filter(item=>owned(item)&&nested(item,['impact']))})):[];
  const experiments=rootOwned && owned(state.revenueEngine || {})?uniqueSources(array(state.revenueEngine?.experiments).filter(owned)).filter(row=>nested(row,['impact','result','outcome'])):[];
  const approvals=rootOwned?uniqueSources(array(state.approvals).filter(owned)).filter(row=>nested(row,['payload','impact','executionImpact'])):[];
  return {...state,evidenceScope:{ambiguousSourceRecordsExcluded},workRecords,approvals,revenueEngine:{...state.revenueEngine,experiments},
    automationRuns:rootOwned?array(state.automationRuns).filter(owned):[],
    subscription:rootOwned && owned(state.subscription || {})?state.subscription:undefined};
}
