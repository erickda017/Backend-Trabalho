-- Rode isso no SQL Editor do Supabase (idempotente: pode rodar de novo com segurança)

create table if not exists clientes (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  telefone text not null,
  valor numeric,
  vencimento text,
  pdf_url text,
  pdf_path text,
  created_at timestamptz default now()
);

create table if not exists envios (
  id uuid primary key default gen_random_uuid(),
  template_mensagem text not null,
  status text not null default 'pendente', -- pendente | agendado | em_andamento | pausado | concluido
  agendado_para timestamptz, -- se preenchido, o envio só começa automaticamente nesse horário
  retomar_em timestamptz, -- quando pausado por limite diário, quando deve retomar automaticamente
  created_at timestamptz default now(),
  finalizado_em timestamptz
);

create table if not exists envio_itens (
  id uuid primary key default gen_random_uuid(),
  envio_id uuid references envios(id) on delete cascade,
  cliente_id uuid references clientes(id) on delete cascade,
  status text not null default 'pendente', -- pendente | enviado | erro | numero_invalido
  mensagem_override text, -- se preenchido, sobrescreve o template do envio para este item
  erro text,
  message_id text, -- id da mensagem no WhatsApp (Baileys), usado pra casar com o webhook de status
  status_entrega text, -- enviado | entregue | lido (atualizado via evento do Baileys)
  entregue_em timestamptz,
  lido_em timestamptz,
  enviado_em timestamptz,
  created_at timestamptz default now()
);

-- Bucket de storage para os PDFs das faturas (criar manualmente em Storage também funciona)
insert into storage.buckets (id, name, public)
values ('faturas', 'faturas', true)
on conflict (id) do nothing;

-- telefone único: permite "upsert" ao reimportar planilha (atualiza em vez de duplicar)
create unique index if not exists clientes_telefone_key on clientes (telefone);

-- índices para acelerar consultas de histórico e limite diário
create index if not exists envio_itens_cliente_id_idx on envio_itens (cliente_id);
create index if not exists envio_itens_enviado_em_idx on envio_itens (enviado_em);
create index if not exists envios_agendado_para_idx on envios (agendado_para) where status = 'agendado';

-- índices adicionais: aceleram os filtros mais frequentes do dispatchQueue/scheduler
-- (buscar itens 'pendente'/'erro' de um envio, e envios 'pausado' aguardando retomar_em)
create index if not exists envio_itens_envio_id_status_idx on envio_itens (envio_id, status);
create index if not exists envios_pausado_retomar_em_idx on envios (retomar_em) where status = 'pausado';

-- Se você já tinha clientes cadastrados ANTES da normalização de telefone (commit que
-- adicionou backend/src/lib/telefone.js), rode isto uma vez pra alinhar os registros
-- antigos ao novo formato (dígitos + código do país, ex: 5511999999999). Sem isso, um
-- cliente antigo salvo como "(11) 99999-9999" não vai bater com o número validado no
-- WhatsApp nem com uma reimportação da planilha no formato novo.
-- ⚠️ Rode o SELECT abaixo antes pra checar se não gera telefone duplicado (dois clientes
-- diferentes cujo telefone normalizado colide) -- se gerar, resolva manualmente antes do UPDATE.
--
-- select telefone, count(*) from (
--   select case when length(regexp_replace(telefone, '\D', '', 'g')) <= 11
--          then '55' || regexp_replace(telefone, '\D', '', 'g')
--          else regexp_replace(telefone, '\D', '', 'g') end as telefone
--   from clientes
-- ) t group by telefone having count(*) > 1;
--
-- update clientes set telefone = (
--   case when length(regexp_replace(telefone, '\D', '', 'g')) <= 11
--        then '55' || regexp_replace(telefone, '\D', '', 'g')
--        else regexp_replace(telefone, '\D', '', 'g') end
-- );

-- Habilita RLS (recomendado já que agora existe login). Como o backend usa a
-- service_role key, ele ignora RLS -- essas políticas só protegem se alguém
-- tentar acessar o banco direto com a chave anônima/pública.
alter table clientes enable row level security;
alter table envios enable row level security;
alter table envio_itens enable row level security;
