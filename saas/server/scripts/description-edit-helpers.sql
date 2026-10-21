-- Source for the prepared forward contract. No table writes or activation.
create function public.runvara_description_replace(p_html text,p_paragraph text,p_text text)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare pos integer:=1; stop integer; n integer; token text; name text; parent text; tail text; hit text[];
  names text[]:=array[]::text[]; starts integer[]:=array[]::integer[]; inners integer[]:=array[]::integer[];
  depth integer; matches integer:=0; inner_start integer; inner_end integer; result text;
  inline_tags text[]:=array['a','span','strong','em','b','i','u','s','small','sub','sup','code','br','img'];
  all_tags text[]:=array['a','span','strong','em','b','i','u','s','small','sub','sup','code','br','img','p','div','section','h1','h2','h3','h4','h5','h6','ul','ol','li'];
  trim_chars text:=U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
begin
  if p_html is null or p_paragraph is null or p_text is null or octet_length(p_html)>12000
    or p_html ~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]'
    or p_text ~ U&'[\0001-\0009\000B-\001F\007F]' or btrim(p_text,trim_chars)=''
    or char_length(p_text)+char_length(regexp_replace(p_text,U&'[^\+010000-\+10FFFF]','','g'))>4000 then
    raise exception using errcode='P0O01',message='WRITE_DESCRIPTION_EDIT_INVALID'; end if;
  while pos<=char_length(p_html) loop
    tail:=substr(p_html,pos); depth:=cardinality(names); parent:=names[depth];
    if left(tail,1)<>'<' then
      stop:=strpos(tail,'<'); n:=case when stop=0 then char_length(tail) else stop-1 end;
      if parent in ('ul','ol') and btrim(left(tail,n),trim_chars)<>'' then
        raise exception using errcode='P0O01',message='WRITE_DESCRIPTION_EDIT_INVALID'; end if;
      pos:=pos+n; continue;
    end if;
    if left(tail,4)='<!--' then
      stop:=strpos(substr(tail,5),'-->');
      if stop=0 or strpos(substr(tail,5,stop-1),'--')>0 then
        raise exception using errcode='P0O01',message='WRITE_DESCRIPTION_EDIT_INVALID'; end if;
      pos:=pos+stop+6; continue;
    end if;
    hit:=regexp_match(tail,E'^(</([A-Za-z][A-Za-z0-9]*)[ \\t\\r\\n]*>)');
    if hit is not null then
      token:=hit[1]; name:=lower(hit[2]);
      if depth=0 or parent<>name then raise exception using errcode='P0O01',message='WRITE_DESCRIPTION_EDIT_INVALID'; end if;
      if name='p' and substr(p_html,starts[depth],pos+char_length(token)-starts[depth])=p_paragraph then
        matches:=matches+1; inner_start:=inners[depth]; inner_end:=pos;
      end if;
      names:=names[1:depth-1]; starts:=starts[1:depth-1]; inners:=inners[1:depth-1];
      pos:=pos+char_length(token); continue;
    end if;
    hit:=regexp_match(tail,E'^(<([A-Za-z][A-Za-z0-9]*)(?:[ \\t\\r\\n]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \\t\\r\\n]*=[ \\t\\r\\n]*(?:"[^"]*"|''[^'']*''))?)*[ \\t\\r\\n]*(/?)>)');
    if hit is null then raise exception using errcode='P0O01',message='WRITE_DESCRIPTION_EDIT_INVALID'; end if;
    token:=hit[1]; name:=lower(hit[2]);
    if not(name=any(all_tags)) or (hit[3]='/' and name not in ('br','img')) or depth>=32
      or (exists(select 1 from unnest(names) x where x=any(inline_tags) or x='p' or x ~ '^h[1-6]$') and not(name=any(inline_tags)))
      or (parent in ('ul','ol') and name<>'li') or (name='li' and coalesce(parent,'') not in ('ul','ol'))
      or (name='a' and 'a'=any(names)) then raise exception using errcode='P0O01',message='WRITE_DESCRIPTION_EDIT_INVALID'; end if;
    if name not in ('br','img') then
      names:=array_append(names,name); starts:=array_append(starts,pos); inners:=array_append(inners,pos+char_length(token));
    end if;
    pos:=pos+char_length(token);
  end loop;
  if cardinality(names)<>0 or matches<>1 then raise exception using errcode='P0O01',message='WRITE_DESCRIPTION_EDIT_INVALID'; end if;
  result:=left(p_html,inner_start-1)||replace(replace(replace(replace(p_text,'&','&amp;'),'<','&lt;'),'>','&gt;'),E'\n','<br>')||substr(p_html,inner_end);
  if result=p_html or octet_length(result)>12000 then raise exception using errcode='P0O01',message='WRITE_DESCRIPTION_EDIT_INVALID'; end if;
  return result;
end $$;

create function public.runvara_description_validate_input(p_input jsonb)
returns void language plpgsql immutable security invoker set search_path='' as $$
declare field text; stamp text;
begin
  if not public.runvara_outcome_exact(p_input,array['schema','productId','operation','baselineHtml','baselineUpdatedAt','paragraphHtml','replacementText','descriptionHtml']) then
    raise exception using errcode='P0O01',message='WRITE_DESCRIPTION_EDIT_INVALID'; end if;
  foreach field in array array['schema','productId','operation','baselineHtml','baselineUpdatedAt','paragraphHtml','replacementText','descriptionHtml'] loop
    if jsonb_typeof(p_input->field) is distinct from 'string' then raise exception using errcode='P0O01',message='WRITE_DESCRIPTION_EDIT_INVALID'; end if;
  end loop;
  if (p_input->>'schema'='runvara-description-edit/v1' and p_input->>'operation'='product_content'
    and p_input->>'productId' ~ '^gid://shopify/Product/[0-9]+$' and char_length(p_input->>'productId')<=100
    and p_input->>'baselineUpdatedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$'
    and p_input->>'descriptionHtml'=public.runvara_description_replace(p_input->>'baselineHtml',p_input->>'paragraphHtml',p_input->>'replacementText')) is not true then
    raise exception using errcode='P0O01',message='WRITE_DESCRIPTION_EDIT_INVALID'; end if;
  stamp:=p_input->>'baselineUpdatedAt';
  if char_length(stamp)=20 then stamp:=replace(stamp,'Z','.000Z'); end if;
  perform public.runvara_outcome_timestamp(to_jsonb(stamp));
end $$;

revoke all on function public.runvara_description_replace(text,text,text) from public,anon,authenticated,service_role;
revoke all on function public.runvara_description_validate_input(jsonb) from public,anon,authenticated,service_role;
