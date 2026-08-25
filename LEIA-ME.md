# Pedidos Lagoa

Os quiosques pedem pelo tablet. A recepção vê na hora, com o tempo correndo, e
empurra o pedido pela cozinha com um toque. O administrador muda cardápio,
preço e abas sem chamar ninguém.

Endereço: **https://guilhermeogera-beep.github.io/pedidos_lagoa/**

---

## 1. O que tem em cada perfil

| Perfil | O que vê |
|---|---|
| **Quiosque 1 a 17** | Cardápio de Comida, Cardápio de Pesca, Dicas do Quiosque, carrinho e "Meus pedidos" |
| **Recepção** | Quadro de pedidos ao vivo, botões de ação, histórico do dia |
| **Administrador** | Tudo isso **mais** a engrenagem ⚙ em cada aba e as configurações gerais |

O tablet de cada quiosque fica **logado permanentemente**. Como o pedido sai de
uma conta que já é do Quiosque 7, a recepção nunca precisa perguntar de onde
veio — o sistema sabe.

---

## 2. Publicar no GitHub (a página)

O repositório é `pedidos_lagoa`, na conta `guilhermeogera-beep`.

1. Suba para o repositório **todos os arquivos desta pasta, menos `_nao-subir`**:

   ```
   index.html   styles.css   config.js   app.js
   quiosque.js  recepcao.js  admin.js    sw.js
   manifest.webmanifest      .nojekyll
   icons/       .github/
   ```

2. No repositório: **Settings → Pages → Source: Deploy from a branch →
   Branch: `main` / `(root)` → Save**.

3. Espere um ou dois minutos e abra o endereço.

> **A pasta `_nao-subir` NÃO vai para o GitHub.** Ela guarda o SQL com as senhas
> em texto puro. O `.gitignore` já a exclui, mas se você subir arrastando os
> arquivos pelo navegador, é você quem precisa deixá-la de fora.

---

## 3. Criar o banco no Supabase

No painel do seu projeto Supabase, abra **SQL Editor** e cole os arquivos de
`_nao-subir/sql/` **na ordem**, um de cada vez, clicando em **Run**:

| Ordem | Arquivo | O que faz |
|---|---|---|
| 1 | `01-tabelas.sql` | Cria as tabelas |
| 2 | `02-logica.sql` | Numeração dos pedidos, totais, histórico de status |
| 3 | `03-seguranca.sql` | Quem pode ver e mexer em quê (RLS) |
| 4 | `04-relatorios.sql` | Views de relatório e o tempo real |
| 5 | `05-dados-iniciais.sql` | Os 17 quiosques, as 3 abas e um cardápio de exemplo |
| 6 | `06-usuarios.sql` | Cria os logins — **troque as senhas antes de rodar** |

Cada arquivo pode ser rodado mais de uma vez sem duplicar nada.

### Ligar o tempo real

Em **Database → Replication** (ou **Realtime**), confirme que a publicação
`supabase_realtime` está ligada para a tabela `orders`. O passo 4 já tenta
fazer isso sozinho; se der um aviso amarelo, faça pelo painel.

---

## 4. Ligar o app no banco

No painel do Supabase: **Project Settings → API**. Copie dois valores e cole no
final do arquivo `config.js`:

```js
supabaseUrl: "https://SEUPROJETO.supabase.co",
supabaseAnonKey: "sb_publishable_...",
```

Suba o `config.js` alterado para o GitHub. Pronto.

> **Enquanto esses dois campos estiverem vazios, o app abre em MODO
> DEMONSTRAÇÃO**: dá para navegar por todas as telas, fazer pedido, ver a
> recepção receber — só que os dados ficam guardados apenas naquele aparelho.
> É a melhor forma de mostrar o sistema para alguém antes de contratar o banco.

---

## 5. Senhas

O sistema completa o e-mail sozinho: quem digita `quiosque7` entra como
`quiosque7@pedidoslagoa.local`.

| Login | Senha (padrão do `06-usuarios.sql`) |
|---|---|
| `adm` | `Lagoa#2026` |
| `recepcao` | `Recep#2026` |
| `quiosque1` … `quiosque17` | `quiosque1@lagoa` … `quiosque17@lagoa` |

**Troque as senhas de `adm` e `recepcao` antes de abrir para o público.**

Para trocar qualquer senha depois, rode no SQL Editor:

```sql
select app.criar_usuario('recepcao', 'a-senha-nova', 'recepcao', null, 'Recepção');
```

A engrenagem do admin (aba **Equipe**) monta esse comando para você copiar.

---

## 6. Instalar nos tablets

O app é um **PWA**: instala como aplicativo, abre em tela cheia, sem barra de
endereço — e ninguém sai da tela sem querer.

**Android / Chrome**
1. Abra o endereço no Chrome.
2. Menu **⋮ → Instalar aplicativo** (ou "Adicionar à tela inicial").
3. Abra pelo ícone novo e faça o login uma única vez.

**iPad / Safari**
1. Abra o endereço no Safari.
2. Botão de compartilhar → **Adicionar à Tela de Início**.
3. Abra pelo ícone e faça o login.

Depois de instalado, deixe o tablet **sem bloqueio de tela** e com o brilho fixo.

---

## 7. Publicar uma versão nova

Os tablets guardam uma cópia do app para funcionar sem internet. Para forçar a
atualização, mude o número de versão em **dois lugares**:

1. `index.html` — todos os `?v=1` viram `?v=2`.
2. `sw.js` — a linha `const CACHE = "pedidos-lagoa-v1";` vira `v2`.

Sem isso, um tablet pode ficar dias com a versão antiga.

---

## 8. White-label: usar em outro lugar

Nada no código é "da Lagoa". Nome, cores, logo, abas, cardápio e quiosques vêm
todos do banco, na linha do cliente (tabela `tenants`).

Para atender outro estabelecimento:

1. Rode no SQL Editor um bloco igual ao do `05-dados-iniciais.sql`, trocando o
   `slug` e o `name`.
2. Crie os usuários daquele cliente com `app.criar_usuario(..., p_tenant => 'outro-slug')`.
3. Publique uma cópia da pasta com o `config.js` apontando para o mesmo banco.

A segurança do banco (RLS) já isola um cliente do outro: **nenhum usuário
enxerga dado de outro estabelecimento**, mesmo que o endereço seja o mesmo.

---

## 9. Quando algo der errado

| Sintoma | O que olhar |
|---|---|
| Tela de login diz "Usuário ou senha não confere" | Rode o `06-usuarios.sql` de novo com a senha certa |
| "Este login existe, mas ainda não tem perfil" | Faltou rodar o `05-dados-iniciais.sql` antes do `06` |
| Pedido não aparece na recepção sem recarregar | Tempo real desligado — veja o passo 3 |
| "Este perfil não tem permissão para isso" | Rode o `03-seguranca.sql` de novo |
| Faixa laranja "MODO DEMONSTRAÇÃO" | Falta preencher `supabaseUrl` e `supabaseAnonKey` no `config.js` |
| Tablet com a tela antiga | Suba a versão (passo 7) e puxe a página para baixo para recarregar |
| Projeto Supabase pausado | Ative o agendamento em `.github/workflows/manter-supabase-acordado.yml` |

---

## 10. Mapa dos arquivos

```
index.html    o esqueleto da página
styles.css    todo o visual (as cores saem de variáveis no topo)
config.js     o que você mexe: marca, opções e as chaves do Supabase
app.js        o núcleo: login, tema, pop-ups, tempo real
quiosque.js   a tela do quiosque (cardápios, dicas, carrinho)
recepcao.js   o quadro de pedidos
admin.js      a engrenagem ⚙ e os relatórios
sw.js         faz o app instalar e abrir sem internet
_nao-subir/   o SQL — NÃO vai para o GitHub
```
