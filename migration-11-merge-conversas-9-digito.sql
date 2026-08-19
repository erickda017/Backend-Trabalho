-- BUG 2: "cliente recebe a fatura e, quando responde, vira outro chat com o
-- número/nome dele do WhatsApp".
--
-- Causa: número de celular BR mudou de 8 pra 9 dígitos na linha. Se o cadastro
-- (planilha/importação) tem o telefone SEM o 9 e o WhatsApp do cliente responde
-- usando o formato ATUAL (com 9) -- ou vice-versa -- as duas strings não batem,
-- o sistema não reconhece que é o MESMO contato, e cria conversa nova sem
-- cliente_id vinculado (por isso aparece com o nome/perfil do WhatsApp dele em
-- vez do nome cadastrado na fatura).
--
-- O código (src/lib/telefone.js + src/services/chatIngest.js) já foi corrigido
-- pra buscar por AMBAS as variações (com/sem o 9) antes de decidir "esse contato
-- não existe ainda". Isso previne duplicatas NOVAS a partir de agora.
--
-- Esse script aqui é o passo único de LIMPEZA do que já duplicou no passado.
-- Rode uma vez, depois do deploy do código corrigido. Idempotente: rodar de novo
-- não faz nada (não vai mais achar pares duplicados).
do $$
declare
  r record;
  variante text;
  destino record;
begin
  for r in select id, telefone, created_at, cliente_id from conversas order by created_at asc loop
    variante := null;

    -- telefone com 13 dígitos, "55" + DDD + 9 dígitos começando em 9 -> gera a
    -- variante sem o 9 (12 dígitos)
    if length(r.telefone) = 13 and left(r.telefone, 2) = '55' and substring(r.telefone from 5 for 1) = '9' then
      variante := left(r.telefone, 4) || substring(r.telefone from 6);
    -- telefone com 12 dígitos, "55" + DDD + 8 dígitos -> gera a variante com o 9
    elsif length(r.telefone) = 12 and left(r.telefone, 2) = '55' then
      variante := left(r.telefone, 4) || '9' || substring(r.telefone from 5);
    end if;

    if variante is not null then
      -- Prioriza como "destino" (quem sobrevive) a conversa que já tem
      -- cliente_id vinculado -- é a que carrega a informação boa. Empate:
      -- fica a mais antiga.
      select * into destino
      from conversas
      where telefone = variante and id <> r.id
      order by (cliente_id is not null) desc, created_at asc
      limit 1;

      if found then
        if destino.id = r.id then
          continue; -- segurança, não deveria acontecer (id <> r.id no where)
        end if;

        update mensagens set conversa_id = destino.id where conversa_id = r.id;

        -- Se a conversa que está saindo tinha cliente_id e a que fica não tinha,
        -- aproveita a vinculação em vez de perder essa informação.
        if destino.cliente_id is null and r.cliente_id is not null then
          update conversas set cliente_id = r.cliente_id where id = destino.id;
        end if;

        delete from conversas where id = r.id;
        raise notice 'Conversa % (telefone %) fundida em % (telefone %)', r.id, r.telefone, destino.id, destino.telefone;
      end if;
    end if;
  end loop;
end $$;
