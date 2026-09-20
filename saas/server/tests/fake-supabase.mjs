// Contract fake: FK creation, unique identities and conditional PATCH semantics.
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
    if (table === 'saas_workspace_state') {
      const id = url.searchParams.get('workspace_id')?.slice(3);
      if (method === 'PATCH') {
        const current = states.get(id), revision = url.searchParams.get('state->>_revision');
        const matches = current && (revision === 'is.null' ? !current._revision : revision === `eq.${current._revision}`);
        if (!matches) return Response.json([]);
        states.set(id, structuredClone(body.state));
        return Response.json([{ workspace_id: id }]);
      }
      if (url.searchParams.has('state->users')) {
        const wanted = JSON.parse(url.searchParams.get('state->users').slice(3))[0].email;
        return Response.json([...states].filter(([, state]) => state.users.some(user => user.email === wanted)).map(([key, state]) => ({ workspace_id: key, users: state.users })));
      }
      if (url.searchParams.get('select') === 'state') return Response.json(states.has(id) ? [{ state: states.get(id) }] : []);
      return Response.json([...states.keys()].slice(Number(url.searchParams.get('offset') || 0), Number(url.searchParams.get('offset') || 0) + Number(url.searchParams.get('limit') || 200)).map(key => ({ workspace_id: key })));
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
    return Response.json((tables.get(table) || []).filter(row => !id || row.workspace_id === id));
  };
  return { fetchImpl, states, tables, calls };
}
