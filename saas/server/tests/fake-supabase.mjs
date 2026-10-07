// Contract fake: FK creation, unique identities and conditional PATCH semantics.
function projectWorkspaceRow(workspaceId, state, select) {
  const row = { workspace_id: workspaceId, state };
  return Object.fromEntries(select.split(',').map(expression => {
    // Only ordinary columns and simple JSON-arrow paths are implemented. Keep
    // projection behavior explicit so a bad query cannot silently fetch state.
    const match = /^(?:([A-Za-z_]\w*):)?(workspace_id|state)((?:(?:->>|->)(?:[A-Za-z_]\w*|\d+))*)$/.exec(expression);
    if (!match) throw new Error(`Unsupported fake Supabase projection: ${expression}`);
    const [, alias, column, path] = match;
    let value = row[column], key = column;
    for (const [, operator, segment] of path.matchAll(/(->>|->)([A-Za-z_]\w*|\d+)/g)) {
      key = segment;
      value = value !== null && typeof value === 'object' && Object.hasOwn(value, segment) ? value[segment] : null;
      if (operator === '->>' && value !== null) value = typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    return [alias || key, value ?? null];
  }));
}
export function fakeSupabase({ initialStates = [], fault = () => null } = {}) {
  const states = new Map(initialStates.map(state => [state.workspace.id, structuredClone(state)]));
  const tables = new Map(), calls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET', table = url.pathname.split('/').pop();
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method, headers: options.headers, body: options.body || '' });
    const failure = fault({ table, method, body, states });
    if (failure) return Response.json(failure, { status: failure.status || 409 });
    if (method === 'HEAD') return new Response(null, { status: 200 });
    if (table === 'runvara_create_workspace') {
      const next = body.p_state;
      if (states.has(next.workspace.id) || [...states.values()].some(state => state.users.some(user => next.users.some(item => item.email.toLowerCase() === user.email.toLowerCase())))) return Response.json({ code: '23505' }, { status: 409 });
      states.set(next.workspace.id, structuredClone(next));
      return new Response(null, { status: 204 });
    }
    if (table === 'runvara_commit_reporting_status') {
      const current = states.get(body.p_workspace_id);
      if (!current || current.workspace?.id !== body.p_workspace_id || current._revision !== body.p_expected_revision) return Response.json([]);
      const next = structuredClone(current);
      next.integrationStatus.reporting = body.p_report;
      next._revision = body.p_next_revision;
      states.set(body.p_workspace_id, next);
      return Response.json([{ workspace_id: body.p_workspace_id }]);
    }
    if (table === 'saas_workspace_state') {
      const id = url.searchParams.get('workspace_id')?.slice(3);
      if (method === 'PATCH') {
        const current = states.get(id), revision = url.searchParams.get('state->>_revision');
        const matches = current && (revision === 'is.null' ? !current._revision : revision === `eq.${current._revision}`);
        if (!matches) return Response.json([]);
        states.set(id, structuredClone(body.state));
        return Response.json([{ workspace_id: id }]);
      }
      let selected = [...states].filter(([key]) => !id || key === id);
      const revision = url.searchParams.get('state->>_revision');
      if (revision !== null) selected = selected.filter(([, state]) => revision === 'is.null' ? state._revision == null : revision === `eq.${state._revision}`);
      if (url.searchParams.has('state->users')) {
        const wanted = JSON.parse(url.searchParams.get('state->users').slice(3))[0].email;
        selected = selected.filter(([, state]) => state.users.some(user => user.email === wanted));
      }
      const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 200);
      return Response.json(selected.slice(offset, offset + limit).map(([key, state]) => projectWorkspaceRow(key, state, url.searchParams.get('select') || 'workspace_id')));
    }
    if (method === 'POST') {
      const rows = tables.get(table) || [];
      const keys = url.searchParams.get('on_conflict').split(',');
      for (const next of body) {
        const previous = rows.findIndex(row => keys.every(key => row[key] === next[key]));
        if (previous < 0) rows.push(next); else rows[previous] = next;
      }
      tables.set(table, rows);
      return new Response(null, { status: 204 });
    }
    const id = url.searchParams.get('workspace_id')?.slice(3);
    const recordId = url.searchParams.get('id')?.slice(3);
    return Response.json((tables.get(table) || []).filter(row => (!id || row.workspace_id === id) && (!recordId || row.id === recordId)));
  };
  return { fetchImpl, states, tables, calls };
}
