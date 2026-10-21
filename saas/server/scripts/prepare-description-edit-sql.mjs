// Generates reviewable FORWARD SQL only. Never connects to any database.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../supabase/', import.meta.url);
const files = ['20261007175355_reviewed_action_outcome_snapshot.sql', '20261008055400_objective_action_outcome_snapshot.sql',
  '20261008144414_protected_content_execution_receipts.sql', '20261008163558_receipt_outcome_consumer.sql'];
const sources = await Promise.all(files.map(name => readFile(new URL('migrations/' + name, root), 'utf8')));
const extract = (index, name) => {
  const text = sources[index].replaceAll('\r\n', '\n');
  const found = new RegExp('create(?: or replace)? function public\\.' + name + '\\(').exec(text);
  if (!found) throw new Error('Missing predecessor function: ' + name);
  return text.slice(found.index, text.indexOf('$$;', found.index) + 3).replace(/^create function/, 'create or replace function');
};
const change = (text, from, to) => {
  if (!text.includes(from)) throw new Error('Predecessor mismatch: ' + from);
  return text.replace(from, to);
};
const out = [`-- PREPARED ONLY: not applied, not migration history, no activation or data rewriting.
-- Install only after disposable PostgreSQL proof and separate production review.
-- Existing function signatures/owners/grants, guards, quotas and ledger rows remain.
-- Source hashes:
${sources.map((text, i) => '-- ' + files[i] + ' sha256=' + createHash('sha256').update(text).digest('hex')).join('\n')}
begin;`, await readFile(new URL('description-edit-helpers.sql', import.meta.url), 'utf8')];
let fn = extract(0, 'runvara_outcome_action_input_text');
const legacySelect = fn.slice(fn.indexOf('  select '), fn.indexOf('\n$$;'));
const keys = ['schema','productId','operation','baselineHtml','baselineUpdatedAt','paragraphHtml','replacementText','descriptionHtml'];
const expression = keys.map((key, i) => `'${i ? ',' : '{'}"${key}":'||(p_input->'${key}')::text`).join('||') + "||'}'";
fn = change(fn, legacySelect, `  select case when p_input->>'schema'='runvara-description-edit/v1' then ${expression}\n  else ${legacySelect.replace('  select ', '')} end`);
out.push(fn);
fn = extract(0, 'runvara_outcome_action_request_digest');
fn = change(fn, 'begin\n', `begin
  if p_input->>'schema'='runvara-description-edit/v1' then
    perform public.runvara_description_validate_input(p_input);
    query_text:='mutation RunvaraProductDescription($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id } userErrors { field message } } }';
    body:='{"query":'||to_jsonb(query_text)::text||',"variables":{"product":{"id":'||(p_input->'productId')::text||',"descriptionHtml":'||(p_input->'descriptionHtml')::text||'}}}';
    request_text:='{"provider":"shopify","phase":"shopify_mutation","method":"POST","url":'||to_jsonb('https://'||p_account||'/admin/api/'||p_api_version||'/graphql.json')::text||',"body":'||to_jsonb(body)::text||'}';
    return encode(sha256(convert_to(request_text,'UTF8')),'hex');
  end if;
`);
out.push(fn);
// Keep the entire manual authority grammar. Only the typed input and its
// source/context discriminants differ; no historical digest is translated.
let description = extract(1, 'runvara_outcome_validate_source_action');
description = change(description, 'public.runvara_outcome_validate_source_action(', 'public.runvara_description_validate_source(');
description = change(description, "  if p_source->>'schema'='runvara-reviewed-source-action/v2' then return public.runvara_outcome_validate_objective_action(p_source,p_workspace_id); end if;\n", '');
description = change(description, "  c:=p_source->'context'; input:=p_source->'input';", "  c:=p_source->'context'; input:=p_source->'input';\n  perform public.runvara_description_validate_input(input);");
description = change(description, "\n      or not public.runvara_outcome_exact(input,array['productId','operation','title','description'])", '');
description = change(description, "p_source->>'schema'='runvara-reviewed-source-action/v1'", "p_source->>'schema'='runvara-reviewed-source-action/v3'");
description = change(description, "c->>'schema'='runvara-recorded-action-context/v1'", "c->>'schema'='runvara-recorded-action-context/v3'");
const start = description.indexOf("and c->'resultId'=input->'productId'"), end = description.indexOf("      and c->>'inputDigest'", start);
if (start < 0 || end < 0) throw new Error('Missing legacy input grammar');
description = description.slice(0, start) + "and c->'resultId'=input->'productId'\n" + description.slice(end);
out.push(description, 'revoke all on function public.runvara_description_validate_source(jsonb,text) from public,anon,authenticated,service_role;');
fn = extract(1, 'runvara_outcome_validate_source_action');
fn = change(fn, 'begin\n', "begin\n  if p_source->>'schema'='runvara-reviewed-source-action/v3' then return public.runvara_description_validate_source(p_source,p_workspace_id); end if;\n");
out.push(fn);
fn = extract(1, 'runvara_outcome_resolve_action');
fn = change(fn, "case when c->>'schema'='runvara-recorded-action-context/v2'", "case when c->>'schema'='runvara-recorded-action-context/v3' then 'runvara-reviewed-source-action/v3' when c->>'schema'='runvara-recorded-action-context/v2'");
out.push(fn);
fn = extract(2, 'runvara_content_request');
fn = change(fn, "r->>'contract'='runvara-content-execution-receipts/v1'", "r->>'contract'=case when r#>>'{admission,schema}'='runvara-content-execution-admission/v2' then 'runvara-content-execution-receipts/v2' else 'runvara-content-execution-receipts/v1' end");
out.push(fn);
fn = extract(2, 'runvara_content_validate_admission');
fn = change(fn, "p_admission->>'schema'='runvara-content-execution-admission/v1'", "p_admission->>'schema' in ('runvara-content-execution-admission/v1','runvara-content-execution-admission/v2')");
out.push(fn);
const versionCheck = `  if ((p_admission->>'schema'='runvara-content-execution-admission/v2') = (p_source->>'schema'='runvara-reviewed-source-action/v3')) is not true then
    raise exception using errcode='P0R01',message='CONTENT_RECEIPT_SOURCE_INVALID'; end if;
`;
fn = extract(2, 'runvara_content_validate_source');
fn = change(fn, 'begin\n', 'begin\n' + versionCheck); out.push(fn);
fn = extract(2, 'runvara_content_make_receipt');
fn = change(fn, 'begin\n', 'begin\n' + versionCheck);
fn = change(fn, "'schema','runvara-content-execution-receipt/v1'", "'schema',case when p_admission->>'schema'='runvara-content-execution-admission/v2' then 'runvara-content-execution-receipt/v2' else 'runvara-content-execution-receipt/v1' end");
out.push(fn);
fn = extract(1, 'runvara_read_business_outcome_review');
fn = change(fn, "'actionLinkContract','runvara-reviewed-action/v2'", "'actionLinkContract','runvara-reviewed-action/v3'"); out.push(fn);
fn = extract(3, 'runvara_read_outcome_content_sources');
fn = change(fn, "'title',source#>'{input,title}'", "'title',case when source->>'schema'='runvara-reviewed-source-action/v3' then to_jsonb('Shopify description change'::text) else source#>'{input,title}' end"); out.push(fn);
fn = extract(3, 'runvara_publish_business_outcome');
fn = change(fn, "action_source->>'schema' is distinct from 'runvara-reviewed-source-action/v1'", "coalesce(action_source->>'schema','') not in ('runvara-reviewed-source-action/v1','runvara-reviewed-source-action/v3')");
// New description edits use only protected publication, never a mutable source.
fn = change(fn, "    association:=source->'intervention';\n    if (association", "    association:=source->'intervention';\n    if action_source->>'schema'='runvara-reviewed-source-action/v3' and source->>'schema'<>'runvara-experiment-measurement/v4' then raise exception using errcode='P0O01',message='OUTCOME_RECEIPT_SOURCE_INVALID'; end if;\n    if (association");
out.push(fn, 'commit;\n');
await mkdir(new URL('prepared/', root), { recursive: true });
await writeFile(new URL('prepared/description-edit-contract.sql', root), out.join('\n\n'));
console.log('Prepared description-edit-contract.sql; no database connection or activation.');
