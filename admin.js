/* ============================================================
   PEDIDOS LAGOA — admin.js
   ============================================================
   Este arquivo é a ENGRENAGEM ⚙ do administrador. Ele faz três coisas:

     1) Publica o window.PLAdmin.abrir(aba, extra), que as outras telas
        chamam quando o admin toca no ⚙ da barra de cima:
              PLAdmin.abrir()               → primeira aba
              PLAdmin.abrir('pedidos')      → ajustes do quadro
              PLAdmin.abrir('cardapio', s)  → cardápio, já na aba s
     2) Escuta o evento 'abrir-config-geral' (o botão 🛠 do topo).
     3) Registra a tela de Relatórios.

   AS CONFIGURAÇÕES SÃO UMA JANELA SÓ, separada por página do app. Antes
   cada engrenagem abria um pop-up diferente, e para trocar um preço e
   depois o horário era preciso fechar tudo e recomeçar. Agora a
   engrenagem só decide em QUAL ABA a janela abre — o resto continua ali
   do lado, a um toque.

   Por que em pop-up e não numa tela cheia de menus: o dono mexe nisso de
   vez em quando, quase sempre no tablet, e sempre OLHANDO para a tela que
   quer mudar. Abrir por cima deixa claro o que está sendo configurado — e
   ao fechar, a tela de trás já se redesenha com o resultado.
   ============================================================ */

// Definido ANTES da IIFE de propósito: quiosque.js e recepcao.js chamam
// PLAdmin.configurarSecao(...) e não devem depender da ordem em que os
// <script> entraram na página. O objeto nasce vazio e é preenchido abaixo.
window.PLAdmin = window.PLAdmin || {};

(function () {
  "use strict";

  var PL = window.PL;
  var esc = PL.esc;

  // Fusos que existem no Brasil. É uma lista curta de propósito: digitar
  // "America/Sao_Paulo" à mão erra fácil, e um fuso errado faz o "dia" do
  // sistema virar na hora errada — os pedidos cairiam no dia seguinte.
  var FUSOS = [
    "America/Sao_Paulo", "America/Bahia", "America/Fortaleza", "America/Recife",
    "America/Belem", "America/Araguaina", "America/Campo_Grande", "America/Cuiaba",
    "America/Porto_Velho", "America/Manaus", "America/Boa_Vista", "America/Rio_Branco",
    "America/Noronha",
  ];

  // ==================================================================
  //  FERRAMENTAS DE APOIO
  // ==================================================================

  // O banco guarda preço em CENTAVOS (número inteiro). Se guardasse em
  // reais quebrados, 0,1 + 0,2 não daria 0,3 no computador e a conta do
  // pedido fecharia com um centavo de diferença de vez em quando.
  function reaisDoCentavos(centavos) {
    return (Number(centavos || 0) / 100).toFixed(2).replace(".", ",");
  }

  // O contrário: o que o admin digitou vira centavos. Aceita "65", "65,00"
  // e "1.234,50", porque cada pessoa digita de um jeito.
  function centavosDoTexto(txt) {
    var s = String(txt === null || txt === undefined ? "" : txt).replace(/[^\d.,]/g, "");
    if (!s) return 0;
    if (s.indexOf(",") >= 0) {
      // tem vírgula: então o ponto só pode ser separador de milhar
      s = s.replace(/\./g, "").replace(",", ".");
    } else if (/\.\d{3}(\.|$)/.test(s)) {
      // "1.234" sem vírgula nenhuma: ponto de milhar também
      s = s.replace(/\./g, "");
    }
    var n = parseFloat(s);
    return isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
  }

  // O Postgres devolve a hora como "11:00:00"; o <input type="time"> só
  // aceita "11:00". Vazio continua vazio (produto sem janela de horário).
  function horaCurtaDoBanco(h) {
    var m = String(h || "").match(/^(\d{2}):(\d{2})/);
    return m ? m[1] + ":" + m[2] : "";
  }

  // "11:00:00" -> "11h" | "11:30:00" -> "11h30"
  function horaBonita(h) {
    var m = String(h || "").match(/^(\d{1,2}):(\d{2})/);
    return m ? m[1].padStart(2, "0") + "h" + (m[2] === "00" ? "" : m[2]) : "";
  }

  // A "chave" da aba é gerada do nome: minúsculo, sem acento, sem espaço.
  // Ela vai junto com cada item vendido (order_items.section_key), por isso
  // nasce aqui uma vez e nunca mais muda.
  function chaveDoTexto(txt) {
    var s = String(txt || "")
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")   // "pescaria" fica sem acento
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 24);
    return s || "aba";
  }

  // Todas as listas do admin são mostradas na mesma ordem que o quiosque vê.
  function porOrdem(lista) {
    return (lista || []).slice().sort(function (a, b) {
      var da = Number(a.sort_order || 0), db = Number(b.sort_order || 0);
      if (da !== db) return da - db;
      return String(a.name || a.label || a.title || "").localeCompare(String(b.name || b.label || b.title || ""));
    });
  }

  // Item novo entra no FIM da lista. O banco não tem como adivinhar onde
  // encaixar, então mandamos o número junto no cadastro.
  function proximaOrdem(lista) {
    var maior = 0;
    (lista || []).forEach(function (x) { maior = Math.max(maior, Number(x.sort_order || 0)); });
    return maior + 1;
  }

  // Troca de lugar um item com o vizinho e devolve os ids na ordem nova.
  // Setas em vez de arrastar: arrastar no tablet erra muito — o dedo sai do
  // item e a lista volta sozinha para o lugar.
  function idsTrocando(lista, id, passo) {
    var i = lista.findIndex(function (x) { return x.id === id; });
    var j = i + passo;
    if (i < 0 || j < 0 || j >= lista.length) return null;   // já está na ponta
    var copia = lista.slice();
    var guarda = copia[i]; copia[i] = copia[j]; copia[j] = guarda;
    return copia.map(function (x) { return x.id; });
  }

  // Toda gravação passa por aqui: assim nenhuma tem como esquecer o
  // try/catch e o aviso em português.
  async function tentar(fn, textoOk) {
    try {
      await fn();
      if (textoOk) PL.aviso(textoOk, "ok");
      return true;
    } catch (e) {
      console.error(e);
      PL.aviso(PL.erroLegivel(e), "erro");
      return false;
    }
  }

  // O núcleo só lê a linha do cliente uma vez, no login. Depois de gravar,
  // atualizamos a cópia que está na memória para as telas de trás já
  // mostrarem o valor novo sem ninguém precisar sair e entrar de novo.
  function atualizarClienteNaMemoria(campos) {
    if (PL.ctx && PL.ctx.cliente) Object.assign(PL.ctx.cliente, campos);
  }

  // Atalhos para ler o que foi digitado num formulário do pop-up.
  function val(corpo, id) {
    var el = PL.$("#" + id, corpo);
    return el ? String(el.value || "").trim() : "";
  }
  function marcado(corpo, id) {
    var el = PL.$("#" + id, corpo);
    return !!(el && el.checked);
  }

  // ------------------------------------------------------------------
  //  PEDAÇOS DE TELA REAPROVEITADOS
  // ------------------------------------------------------------------

  // Uma linha da .lista-edit. Todas as listas do admin têm a mesma cara:
  // nome em cima, explicação embaixo, botões à direita.
  // ATENÇÃO: 'nome' e 'sub' entram como HTML — quem chama já escapou.
  function linhaEdit(op) {
    var acoes = "";
    if (op.reordena) {
      acoes += botaoAcao("subir", "↑", "btn-neutral", "Subir na lista");
      acoes += botaoAcao("descer", "↓", "btn-neutral", "Descer na lista");
    }
    if (op.chaveSwitch) {
      acoes += `<label class="switch" title="${esc(op.dicaSwitch || "")}">
          <input type="checkbox" data-acao="${esc(op.chaveSwitch)}"${op.ligado ? " checked" : ""} />
          <span class="trilho"></span>
          <span>${esc(op.rotuloSwitch || "")}</span>
        </label>`;
    }
    (op.botoes || []).forEach(function (b) {
      acoes += botaoAcao(b.acao, b.texto, b.classe, b.dica);
    });
    return `
      <div class="le${op.inativo ? " inativo" : ""}" data-id="${esc(op.id)}">
        <div class="le-info">
          <div class="le-nome">${op.nome}</div>
          ${op.sub ? `<div class="le-sub">${op.sub}</div>` : ""}
        </div>
        <div class="le-acoes">${acoes}</div>
      </div>`;
  }

  // Alvo de toque de 44px: o admin mexe nisso no tablet, muitas vezes de pé.
  function botaoAcao(acao, texto, classe, dica) {
    return `<button type="button" class="btn btn-sm ${classe || "btn-outline"}"
      data-acao="${esc(acao)}" title="${esc(dica || texto)}"
      style="min-height:44px;min-width:44px">${esc(texto)}</button>`;
  }

  // Um clique/mudança em qualquer botão da lista cai numa função só.
  // Usa onclick/onchange (e não addEventListener) de propósito: a lista é
  // redesenhada a cada gravação e o ouvinte antigo seria somado ao novo,
  // fazendo a mesma ação rodar duas vezes.
  function ligarAcoes(caixa, fn) {
    caixa.onclick = function (ev) {
      var alvo = ev.target.closest("[data-acao]");
      // o clique no switch já vem pelo onchange; sem isto agiria duas vezes
      if (!alvo || alvo.tagName === "INPUT") return;
      var linha = alvo.closest("[data-id]");
      fn(alvo.dataset.acao, linha ? linha.dataset.id : null, alvo);
    };
    caixa.onchange = function (ev) {
      var alvo = ev.target.closest("input[data-acao]");
      if (!alvo) return;
      var linha = alvo.closest("[data-id]");
      fn(alvo.dataset.acao, linha ? linha.dataset.id : null, alvo);
    };
  }

  // Pop-up de formulário (criar/editar). Abre POR CIMA do pop-up da lista —
  // o núcleo empilha os modais, então a lista continua atrás, no lugar.
  function abrirFormulario(op) {
    return PL.modal({
      titulo: op.titulo,
      corpo: op.corpo,
      larga: op.larga,
      aoAbrir: op.aoAbrir,
      botoes: [
        { texto: "Cancelar", classe: "btn-neutral", acao: function (fechar) { fechar(); } },
        {
          texto: op.textoSalvar || "Salvar", classe: "btn-primary", id: "btnSalvarForm",
          acao: async function (fechar, api) {
            var botao = PL.$("#btnSalvarForm", api.fundo);
            var antes = botao ? botao.textContent : "";
            if (botao) { botao.disabled = true; botao.textContent = "Salvando…"; }
            try {
              // aoSalvar devolvendo false = faltou preencher algo; o pop-up
              // fica aberto com o que já foi digitado
              var r = await op.aoSalvar(api.corpo, api);
              if (r === false) return;
              PL.aviso("Salvo!", "ok");
              fechar();
            } catch (e) {
              console.error(e);
              PL.aviso(PL.erroLegivel(e), "erro");
            } finally {
              if (botao) { botao.disabled = false; botao.textContent = antes; }
            }
          },
        },
      ],
    });
  }

  // Pop-up com abas. O núcleo desenha a PRIMEIRA aba antes de chamar o
  // aoAbrir dela, então cada aba entrega só um esqueleto vazio e quem
  // preenche é sempre o aoAbrir — inclusive na abertura.
  function modalComAbas(op) {
    var abas = op.abas;
    return PL.modal({
      titulo: op.titulo,
      larga: op.larga !== false,
      abas: abas,
      botoes: op.botoes || [{ texto: "Fechar", classe: "btn-primary", acao: function (f) { f(); } }],
      aoFechar: op.aoFechar,
      aoAbrir: function (corpo, api) {
        if (abas[0] && abas[0].aoAbrir) abas[0].aoAbrir(corpo, api);
      },
    });
  }

  // Cópia para a área de transferência. O jeito moderno só funciona em
  // página segura (https); no tablet velho ou em http caímos no truque
  // antigo do textarea escondido — melhor um caminho feio do que um botão
  // que não faz nada.
  function copiarTexto(texto) {
    function pelaVelha() {
      try {
        var t = document.createElement("textarea");
        t.value = texto;
        t.setAttribute("readonly", "");
        t.style.position = "fixed";
        t.style.opacity = "0";
        document.body.appendChild(t);
        t.select();
        var deu = document.execCommand("copy");
        t.remove();
        PL.aviso(deu ? "Copiado!" : "Não deu para copiar. Selecione o texto e copie na mão.", deu ? "ok" : "avisa");
      } catch (e) {
        PL.aviso("Não deu para copiar. Selecione o texto e copie na mão.", "avisa");
      }
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(texto)
          .then(function () { PL.aviso("Copiado!", "ok"); })
          .catch(pelaVelha);
        return;
      }
    } catch (e) { /* cai no de baixo */ }
    pelaVelha();
  }

  // Uma célula de planilha. Se o texto começa com = + - @ o Excel abre como
  // FÓRMULA; o apóstrofo força a leitura como texto.
  function celulaCsv(v) {
    var s = String(v === null || v === undefined ? "" : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // ";" como separador e o BOM na frente: é assim que o Excel em português
  // abre o arquivo já com as colunas separadas e os acentos certos.
  function baixarCsv(nome, linhas) {
    var txt = "\uFEFF" + linhas.map(function (l) { return l.map(celulaCsv).join(";"); }).join("\r\n");
    var blob = new Blob([txt], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ==================================================================
  //  CONFIGURAR UMA ABA DO QUIOSQUE   (o ⚙ da tela do quiosque)
  // ==================================================================
  function configurarSecao(secao) {
    if (!secao || !secao.id) { PL.aviso("Escolha uma aba primeiro.", "avisa"); return; }
    var idSecao = secao.id;

    // A cada recarga do catálogo a linha da seção é outra na memória.
    // Buscar sempre pelo id evita editar em cima de uma cópia velha.
    function daSecao() {
      return PL.catalogo.secoes.find(function (s) { return s.id === idSecao; }) || secao;
    }

    var abas = [];
    if (daSecao().kind === "tips") {
      abas.push(abaDicas(daSecao));
    } else {
      abas.push(abaProdutos(daSecao));
      abas.push(abaCategorias(daSecao));
    }
    abas.push(abaDaPropriaAba(daSecao));

    var s = daSecao();
    modalComAbas({
      titulo: (s.icon ? s.icon + " " : "") + (s.label || "Aba"),
      larga: true,
      abas: abas,
      // ao fechar, a tela do quiosque atrás precisa aparecer já com o que
      // acabou de ser mudado
      aoFechar: function () { PL.recarregarTela(); },
    });
  }

  // ------------------------------------------------------------------
  //  ABA "PRODUTOS"
  // ------------------------------------------------------------------
  function abaProdutos(daSecao) {
    return {
      id: "produtos",
      rotulo: "Produtos",
      corpo: '<div id="listaProdutos"></div>',
      aoAbrir: function (corpo) { desenharProdutos(corpo, daSecao); },
    };
  }

  function desenharProdutos(corpo, daSecao) {
    var caixa = PL.$("#listaProdutos", corpo);
    if (!caixa) return;
    var secao = daSecao();
    var produtos = porOrdem(PL.catalogo.produtos.filter(function (p) { return p.section_id === secao.id; }));
    var categorias = porOrdem(PL.catalogo.categorias.filter(function (c) { return c.section_id === secao.id; }));

    function nomeDaCategoria(id) {
      var c = categorias.find(function (x) { return x.id === id; });
      return c ? c.name : "sem categoria";
    }

    caixa.innerHTML = `
      <div class="card-head">
        <span class="hint">${produtos.length} produto(s). As setas mudam a ordem em que o quiosque vê.</span>
        <button type="button" class="btn btn-sm btn-primary" data-acao="novo" style="min-height:44px">+ Novo produto</button>
      </div>
      ${produtos.length ? `<div class="lista-edit">${produtos.map(function (p) {
        var marcas = [];
        if (!p.active) marcas.push("escondido do cardápio");
        if (!p.available) marcas.push("marcado como acabou");
        if (p.available_from && p.available_to) {
          marcas.push("só das " + horaBonita(p.available_from) + " às " + horaBonita(p.available_to));
        }
        return linhaEdit({
          id: p.id,
          inativo: !p.active,
          nome: `${esc(p.name)} &nbsp;<span style="color:var(--brand-dark)">${PL.dinheiro(p.price_cents)}</span>`,
          sub: `${esc(nomeDaCategoria(p.category_id))} · por ${esc(p.unit || "un")}${marcas.length ? " · " + esc(marcas.join(" · ")) : ""}`,
          reordena: true,
          chaveSwitch: "disponivel",
          rotuloSwitch: "Tem hoje",
          dicaSwitch: "Desligue quando acabar. O produto continua no cardápio, mas ninguém consegue pedir.",
          ligado: !!p.available,
          botoes: [
            { acao: "editar", texto: "Editar", classe: "btn-outline" },
            { acao: "excluir", texto: "Excluir", classe: "btn-danger" },
          ],
        });
      }).join("")}</div>` : `
      <div class="vazio">
        <b>Nenhum produto nesta aba ainda</b>
        Toque em “+ Novo produto” para começar o cardápio.
      </div>`}
    `;

    ligarAcoes(caixa, async function (acao, id, alvo) {
      var prod = produtos.find(function (p) { return p.id === id; });

      if (acao === "novo") { formularioProduto(null, secao, categorias, function () { desenharProdutos(corpo, daSecao); }); return; }
      if (acao === "editar" && prod) { formularioProduto(prod, secao, categorias, function () { desenharProdutos(corpo, daSecao); }); return; }

      if (acao === "disponivel" && prod) {
        var querido = alvo.checked;
        var ok = await tentar(function () { return PL.backend.disponibilidade(prod.id, querido); },
          querido ? "Voltou para o cardápio." : "Marcado como acabou.");
        if (!ok) alvo.checked = !querido;   // deu erro: o botão volta para onde estava
        await PL.recarregarCatalogo();
        desenharProdutos(corpo, daSecao);
        return;
      }

      if (acao === "subir" || acao === "descer") {
        var ids = idsTrocando(produtos, id, acao === "subir" ? -1 : 1);
        if (!ids) return;                                  // já está na ponta
        await tentar(function () { return PL.backend.reordenar("produtos", ids); });
        await PL.recarregarCatalogo();
        desenharProdutos(corpo, daSecao);
        return;
      }

      if (acao === "excluir" && prod) {
        var certeza = await PL.confirmar({
          titulo: "Excluir " + prod.name,
          texto: `O produto some do cardápio do quiosque.<br><br>
                  <b>Os pedidos antigos não mudam:</b> cada item guardou o nome e o preço
                  do dia em que foi pedido, então o histórico e os relatórios continuam certos.<br><br>
                  Se for só uma falta de hoje, não exclua — desligue o botão <b>“Tem hoje”</b>.`,
          ok: "Excluir mesmo assim", perigo: true,
        });
        if (!certeza) return;
        await tentar(function () { return PL.backend.remover("produtos", prod.id); }, "Produto excluído.");
        await PL.recarregarCatalogo();
        desenharProdutos(corpo, daSecao);
      }
    });
  }

  function formularioProduto(prod, secao, categorias, aoTerminar) {
    var novo = !prod;
    var p = prod || {};
    abrirFormulario({
      titulo: novo ? "Novo produto" : "Editar produto",
      corpo: `
        <label class="field">
          <span>Nome do produto</span>
          <input type="text" id="pNome" value="${esc(p.name || "")}" placeholder="Porção de tilápia frita" />
        </label>
        <label class="field">
          <span>Descrição (opcional)</span>
          <input type="text" id="pDesc" value="${esc(p.description || "")}" placeholder="Serve 2 pessoas, acompanha limão" />
        </label>
        <div class="field-row">
          <label class="field">
            <span>Preço (R$)</span>
            <input type="text" id="pPreco" inputmode="decimal"
                   value="${esc(novo ? "" : reaisDoCentavos(p.price_cents))}" placeholder="65,00" />
            <span class="field-hint">Use vírgula: 65,00</span>
          </label>
          <label class="field">
            <span>Unidade</span>
            <input type="text" id="pUnidade" value="${esc(p.unit || "un")}" placeholder="porção, un, kg, diária" />
          </label>
        </div>
        <label class="field">
          <span>Categoria</span>
          <select id="pCategoria">
            <option value="">— sem categoria —</option>
            ${categorias.map(function (c) {
              return `<option value="${esc(c.id)}"${p.category_id === c.id ? " selected" : ""}>${esc(c.name)}</option>`;
            }).join("")}
          </select>
          <span class="field-hint">A categoria vira o grupo do cardápio (Porções, Bebidas…).</span>
        </label>
        <div class="field">
          <span>Foto (opcional)</span>
          <div class="foto-escolha">
            <div class="foto-previa" id="pPrevia">
              ${p.image_url
                ? `<img src="${esc(p.image_url)}" alt="" />`
                : '<span class="foto-vazia">sem foto</span>'}
            </div>
            <div class="foto-botoes">
              <input type="file" id="pArquivo" accept="image/*" hidden />
              <button type="button" class="btn btn-outline" id="pEscolher" style="min-height:44px">
                📷 ${p.image_url ? "Trocar foto" : "Escolher foto"}
              </button>
              <button type="button" class="btn btn-danger btn-sm" id="pTirar"
                      style="min-height:44px" ${p.image_url ? "" : "hidden"}>Tirar foto</button>
              <span class="field-hint" id="pFotoMsg">
                A foto é reduzida no próprio aparelho antes de subir — fica leve
                para o tablet do quiosque carregar.
              </span>
            </div>
          </div>
          <details style="margin-top:8px">
            <summary class="hint" style="cursor:pointer">Ou colar o endereço de uma imagem</summary>
            <input type="url" id="pFoto" value="${esc(p.image_url || "")}"
                   placeholder="https://…/tilapia.jpg" style="margin-top:8px" />
            <span class="field-hint">Para imagem que já está em outro lugar da internet.</span>
          </details>
        </div>

        <div class="field-row">
          <label class="field">
            <span>Só pode pedir a partir de</span>
            <input type="time" id="pDe" value="${esc(horaCurtaDoBanco(p.available_from))}" />
          </label>
          <label class="field">
            <span>Até</span>
            <input type="time" id="pAte" value="${esc(horaCurtaDoBanco(p.available_to))}" />
          </label>
        </div>
        <span class="field-hint" style="display:block;margin:-6px 0 4px">
          Deixe os dois <b>vazios</b> para vender o dia inteiro — é o caso da maioria.
          Fora da janela o item continua no cardápio, apagado e com o horário escrito:
          assim ninguém acha que acabou. Uma janela que passa da meia-noite
          (18:00 às 02:00) também funciona.
        </span>
        <label class="switch">
          <input type="checkbox" id="pAtivo"${novo || p.active ? " checked" : ""} />
          <span class="trilho"></span>
          <span>Aparece no cardápio</span>
        </label>
        <label class="switch">
          <input type="checkbox" id="pDisponivel"${novo || p.available ? " checked" : ""} />
          <span class="trilho"></span>
          <span>Tem hoje (dá para pedir)</span>
        </label>`,

      aoAbrir: function (corpo, api) {
        var arquivo  = PL.$("#pArquivo", corpo);
        var escolher = PL.$("#pEscolher", corpo);
        var tirar    = PL.$("#pTirar", corpo);
        var previa   = PL.$("#pPrevia", corpo);
        var campoUrl = PL.$("#pFoto", corpo);
        var msg      = PL.$("#pFotoMsg", corpo);
        // a foto que este formulário substituiu, para apagar do
        // armazenamento só DEPOIS que a gravação der certo
        var trocada = null;

        function mostrar(url) {
          previa.innerHTML = url
            ? '<img src="' + esc(url) + '" alt="" />'
            : '<span class="foto-vazia">sem foto</span>';
          escolher.textContent = url ? "📷 Trocar foto" : "📷 Escolher foto";
          tirar.hidden = !url;
        }

        escolher.onclick = function () { arquivo.click(); };

        arquivo.onchange = async function () {
          var f = arquivo.files && arquivo.files[0];
          if (!f) return;

          escolher.disabled = true;
          escolher.textContent = "Enviando…";
          msg.textContent = "Preparando a imagem…";

          try {
            var anterior = campoUrl.value;
            var url = await PL.backend.subirFoto(f);
            campoUrl.value = url;
            if (anterior && anterior !== url) trocada = anterior;
            mostrar(url);
            msg.textContent = "Foto pronta. Ela entra no cardápio quando você salvar.";
          } catch (e) {
            console.error("Subir foto:", e);
            msg.textContent = PL.erroLegivel(e);
          } finally {
            escolher.disabled = false;
            if (!campoUrl.value) escolher.textContent = "📷 Escolher foto";
            arquivo.value = "";   // deixa escolher o MESMO arquivo de novo
          }
        };

        tirar.onclick = function () {
          if (campoUrl.value) trocada = campoUrl.value;
          campoUrl.value = "";
          mostrar("");
          msg.textContent = "A foto sai do cardápio quando você salvar.";
        };

        // quem cola um endereço à mão também vê a prévia
        campoUrl.oninput = function () { mostrar(campoUrl.value.trim()); };

        // Guardado no formulário para o aoSalvar alcançar: a foto antiga só
        // é apagada depois que a gravação deu certo. Apagar antes deixaria
        // o produto sem imagem se o salvamento falhasse.
        api.fotoTrocada = function () { return trocada; };
      },

      aoSalvar: async function (corpo, api) {
        var nome = val(corpo, "pNome");
        if (!nome) { PL.aviso("Escreva o nome do produto.", "avisa"); return false; }

        var linha = {
          section_id: secao.id,
          category_id: val(corpo, "pCategoria") || null,
          name: nome,
          description: val(corpo, "pDesc") || null,
          // vai para o banco em CENTAVOS, arredondado — nada de número quebrado
          price_cents: centavosDoTexto(val(corpo, "pPreco")),
          unit: val(corpo, "pUnidade") || "un",
          image_url: val(corpo, "pFoto") || null,
          active: marcado(corpo, "pAtivo"),
          available: marcado(corpo, "pDisponivel"),
          // Os dois andam juntos: só um deles preenchido não é uma janela,
          // é um campo esquecido pela metade — e viraria "sem horário".
          available_from: val(corpo, "pDe") || null,
          available_to: val(corpo, "pAte") || null,
        };
        if (!linha.available_from || !linha.available_to) {
          linha.available_from = null;
          linha.available_to = null;
        }
        if (novo) linha.sort_order = proximaOrdem(PL.catalogo.produtos.filter(function (x) { return x.section_id === secao.id; }));
        else linha.id = p.id;

        await PL.backend.salvar("produtos", linha);
        await PL.recarregarCatalogo();

        // A foto antiga só sai do armazenamento AGORA, com a gravação já
        // feita. E só se ninguém mais estiver usando ela — dois produtos
        // podem apontar para a mesma imagem se alguém copiou o endereço.
        var velha = api && api.fotoTrocada && api.fotoTrocada();
        if (velha) {
          var aindaEmUso = (PL.catalogo.produtos || []).some(function (x) {
            return x.image_url === velha;
          });
          if (!aindaEmUso) {
            try { await PL.backend.apagarFoto(velha); }
            catch (e) { console.warn("Foto antiga ficou no armazenamento:", e); }
          }
        }

        if (aoTerminar) aoTerminar();
      },
    });
  }

  // ------------------------------------------------------------------
  //  ABA "CATEGORIAS"
  // ------------------------------------------------------------------
  function abaCategorias(daSecao) {
    return {
      id: "categorias",
      rotulo: "Categorias",
      corpo: '<div id="listaCategorias"></div>',
      aoAbrir: function (corpo) { desenharCategorias(corpo, daSecao); },
    };
  }

  function desenharCategorias(corpo, daSecao) {
    var caixa = PL.$("#listaCategorias", corpo);
    if (!caixa) return;
    var secao = daSecao();
    var categorias = porOrdem(PL.catalogo.categorias.filter(function (c) { return c.section_id === secao.id; }));
    var produtos = PL.catalogo.produtos.filter(function (p) { return p.section_id === secao.id; });

    caixa.innerHTML = `
      <div class="card-head">
        <span class="hint">As categorias são os grupos do cardápio. A ordem aqui é a ordem dos grupos na tela.</span>
        <button type="button" class="btn btn-sm btn-primary" data-acao="novo" style="min-height:44px">+ Nova categoria</button>
      </div>
      ${categorias.length ? `<div class="lista-edit">${categorias.map(function (c) {
        var quantos = produtos.filter(function (p) { return p.category_id === c.id; }).length;
        return linhaEdit({
          id: c.id,
          inativo: !c.active,
          nome: esc(c.name),
          sub: `${quantos} produto(s)${c.active ? "" : " · escondida do cardápio"}`,
          reordena: true,
          chaveSwitch: "ativa",
          rotuloSwitch: "Aparece",
          dicaSwitch: "Desligado, o grupo some do cardápio sem apagar nada.",
          ligado: !!c.active,
          botoes: [
            { acao: "editar", texto: "Editar", classe: "btn-outline" },
            { acao: "excluir", texto: "Excluir", classe: "btn-danger" },
          ],
        });
      }).join("")}</div>` : `
      <div class="vazio">
        <b>Nenhuma categoria nesta aba</b>
        Sem categoria os produtos aparecem todos juntos, numa lista só. Funciona, mas cansa a vista.
      </div>`}
    `;

    ligarAcoes(caixa, async function (acao, id, alvo) {
      var cat = categorias.find(function (c) { return c.id === id; });

      if (acao === "novo") { formularioCategoria(null, secao, function () { desenharCategorias(corpo, daSecao); }); return; }
      if (acao === "editar" && cat) { formularioCategoria(cat, secao, function () { desenharCategorias(corpo, daSecao); }); return; }

      if (acao === "ativa" && cat) {
        var querido = alvo.checked;
        var ok = await tentar(function () { return PL.backend.salvar("categorias", { id: cat.id, active: querido }); }, "Salvo!");
        if (!ok) alvo.checked = !querido;
        await PL.recarregarCatalogo();
        desenharCategorias(corpo, daSecao);
        return;
      }

      if (acao === "subir" || acao === "descer") {
        var ids = idsTrocando(categorias, id, acao === "subir" ? -1 : 1);
        if (!ids) return;
        await tentar(function () { return PL.backend.reordenar("categorias", ids); });
        await PL.recarregarCatalogo();
        desenharCategorias(corpo, daSecao);
        return;
      }

      if (acao === "excluir" && cat) {
        var quantos = produtos.filter(function (p) { return p.category_id === cat.id; }).length;
        var certeza = await PL.confirmar({
          titulo: "Excluir a categoria " + cat.name,
          texto: quantos
            ? `Os <b>${quantos} produto(s)</b> desta categoria <b>não são apagados</b>: eles ficam
               “sem categoria” e continuam no cardápio, só que soltos, fora de qualquer grupo.<br><br>
               Se é só para sumir da tela por um tempo, desligue o botão <b>“Aparece”</b>.`
            : "Esta categoria está vazia. Nada mais será apagado junto.",
          ok: "Excluir", perigo: true,
        });
        if (!certeza) return;
        await tentar(function () { return PL.backend.remover("categorias", cat.id); }, "Categoria excluída.");
        await PL.recarregarCatalogo();
        desenharCategorias(corpo, daSecao);
      }
    });
  }

  function formularioCategoria(cat, secao, aoTerminar) {
    var novo = !cat;
    var c = cat || {};
    abrirFormulario({
      titulo: novo ? "Nova categoria" : "Editar categoria",
      corpo: `
        <label class="field">
          <span>Nome da categoria</span>
          <input type="text" id="cNome" value="${esc(c.name || "")}" placeholder="Porções, Bebidas, Iscas…" />
        </label>
        <label class="switch">
          <input type="checkbox" id="cAtiva"${novo || c.active ? " checked" : ""} />
          <span class="trilho"></span>
          <span>Aparece no cardápio</span>
        </label>`,
      aoSalvar: async function (corpo) {
        var nome = val(corpo, "cNome");
        if (!nome) { PL.aviso("Escreva o nome da categoria.", "avisa"); return false; }
        var linha = { section_id: secao.id, name: nome, active: marcado(corpo, "cAtiva") };
        if (novo) linha.sort_order = proximaOrdem(PL.catalogo.categorias.filter(function (x) { return x.section_id === secao.id; }));
        else linha.id = c.id;
        await PL.backend.salvar("categorias", linha);
        await PL.recarregarCatalogo();
        if (aoTerminar) aoTerminar();
      },
    });
  }

  // ------------------------------------------------------------------
  //  ABA "DICAS"   (seções do tipo 'tips': conteúdo, sem carrinho)
  // ------------------------------------------------------------------
  function abaDicas(daSecao) {
    return {
      id: "dicas",
      rotulo: "Dicas",
      corpo: '<div id="listaDicas"></div>',
      aoAbrir: function (corpo) { desenharDicas(corpo, daSecao); },
    };
  }

  function desenharDicas(corpo, daSecao) {
    var caixa = PL.$("#listaDicas", corpo);
    if (!caixa) return;
    var secao = daSecao();
    var dicas = porOrdem(PL.catalogo.dicas.filter(function (d) { return d.section_id === secao.id; }));
    var quiosques = porOrdem(PL.catalogo.quiosques);

    function nomeDoQuiosque(id) {
      if (!id) return "Todos os quiosques";
      var q = quiosques.find(function (x) { return x.id === id; });
      return q ? q.name : "Quiosque removido";
    }

    caixa.innerHTML = `
      <div class="card-head">
        <span class="hint">As fixadas aparecem primeiro. A ordem das outras é a desta lista.</span>
        <button type="button" class="btn btn-sm btn-primary" data-acao="novo" style="min-height:44px">+ Nova dica</button>
      </div>
      ${dicas.length ? `<div class="lista-edit">${dicas.map(function (d) {
        var marcas = [nomeDoQuiosque(d.kiosk_id)];
        if (d.pinned) marcas.push("fixada no topo");
        if (!d.active) marcas.push("escondida");
        return linhaEdit({
          id: d.id,
          inativo: !d.active,
          nome: `${d.pinned ? "📌 " : ""}${esc(d.title)}`,
          sub: esc(marcas.join(" · ")),
          reordena: true,
          chaveSwitch: "ativa",
          rotuloSwitch: "Aparece",
          dicaSwitch: "Desligado, a dica some da tela do quiosque sem ser apagada.",
          ligado: !!d.active,
          botoes: [
            { acao: "editar", texto: "Editar", classe: "btn-outline" },
            { acao: "excluir", texto: "Excluir", classe: "btn-danger" },
          ],
        });
      }).join("")}</div>` : `
      <div class="vazio">
        <b>Nenhuma dica ainda</b>
        Esta aba é o mural do quiosque: horário de pesca, regras da lagoa, senha do Wi-Fi.
      </div>`}
    `;

    ligarAcoes(caixa, async function (acao, id, alvo) {
      var dica = dicas.find(function (d) { return d.id === id; });

      if (acao === "novo") { formularioDica(null, secao, quiosques, function () { desenharDicas(corpo, daSecao); }); return; }
      if (acao === "editar" && dica) { formularioDica(dica, secao, quiosques, function () { desenharDicas(corpo, daSecao); }); return; }

      if (acao === "ativa" && dica) {
        var querido = alvo.checked;
        var ok = await tentar(function () { return PL.backend.salvar("dicas", { id: dica.id, active: querido }); }, "Salvo!");
        if (!ok) alvo.checked = !querido;
        await PL.recarregarCatalogo();
        desenharDicas(corpo, daSecao);
        return;
      }

      if (acao === "subir" || acao === "descer") {
        var ids = idsTrocando(dicas, id, acao === "subir" ? -1 : 1);
        if (!ids) return;
        await tentar(function () { return PL.backend.reordenar("dicas", ids); });
        await PL.recarregarCatalogo();
        desenharDicas(corpo, daSecao);
        return;
      }

      if (acao === "excluir" && dica) {
        var certeza = await PL.confirmar({
          titulo: "Excluir a dica",
          texto: `“${esc(dica.title)}” some do mural para sempre. Não dá para desfazer.<br><br>
                  Se for só por um tempo (uma promoção que acabou, por exemplo),
                  desligue o botão <b>“Aparece”</b> em vez de excluir.`,
          ok: "Excluir", perigo: true,
        });
        if (!certeza) return;
        await tentar(function () { return PL.backend.remover("dicas", dica.id); }, "Dica excluída.");
        await PL.recarregarCatalogo();
        desenharDicas(corpo, daSecao);
      }
    });
  }

  function formularioDica(dica, secao, quiosques, aoTerminar) {
    var novo = !dica;
    var d = dica || {};
    abrirFormulario({
      titulo: novo ? "Nova dica" : "Editar dica",
      corpo: `
        <label class="field">
          <span>Título</span>
          <input type="text" id="dTitulo" value="${esc(d.title || "")}" placeholder="Melhor horário para pescar" />
        </label>
        <label class="field">
          <span>Texto</span>
          <textarea id="dTexto" rows="6" placeholder="Escreva como se estivesse explicando para o cliente na recepção.">${esc(d.body || "")}</textarea>
          <span class="field-hint">As quebras de linha são respeitadas na tela do quiosque.</span>
        </label>
        <label class="field">
          <span>Endereço da foto (opcional)</span>
          <input type="url" id="dFoto" value="${esc(d.image_url || "")}" placeholder="https://…/lagoa.jpg" />
        </label>
        <label class="field">
          <span>Mostrar em</span>
          <select id="dQuiosque">
            <option value="">Todos os quiosques</option>
            ${quiosques.map(function (q) {
              return `<option value="${esc(q.id)}"${d.kiosk_id === q.id ? " selected" : ""}>${esc(q.name)}</option>`;
            }).join("")}
          </select>
          <span class="field-hint">Serve para um aviso de um quiosque só (“a tomada deste quiosque está em manutenção”).</span>
        </label>
        <label class="switch">
          <input type="checkbox" id="dFixar"${d.pinned ? " checked" : ""} />
          <span class="trilho"></span>
          <span>Fixar no topo</span>
        </label>
        <label class="switch">
          <input type="checkbox" id="dAtiva"${novo || d.active ? " checked" : ""} />
          <span class="trilho"></span>
          <span>Aparece no mural</span>
        </label>`,
      aoSalvar: async function (corpo) {
        var titulo = val(corpo, "dTitulo");
        if (!titulo) { PL.aviso("Escreva o título da dica.", "avisa"); return false; }
        var linha = {
          section_id: secao.id,
          kiosk_id: val(corpo, "dQuiosque") || null,   // vazio = vale para todos
          title: titulo,
          body: val(corpo, "dTexto") || null,
          image_url: val(corpo, "dFoto") || null,
          pinned: marcado(corpo, "dFixar"),
          active: marcado(corpo, "dAtiva"),
        };
        if (novo) linha.sort_order = proximaOrdem(PL.catalogo.dicas.filter(function (x) { return x.section_id === secao.id; }));
        else linha.id = d.id;
        await PL.backend.salvar("dicas", linha);
        await PL.recarregarCatalogo();
        if (aoTerminar) aoTerminar();
      },
    });
  }

  // ------------------------------------------------------------------
  //  ABA "ESTA ABA"  (o cadastro da própria seção)
  // ------------------------------------------------------------------
  function abaDaPropriaAba(daSecao) {
    return {
      id: "estaAba",
      rotulo: "Esta aba",
      corpo: '<div id="editaSecao"></div>',
      aoAbrir: function (corpo, api) { desenharEditaSecao(corpo, daSecao, api); },
    };
  }

  function desenharEditaSecao(corpo, daSecao, api) {
    var caixa = PL.$("#editaSecao", corpo);
    if (!caixa) return;
    var s = daSecao();

    caixa.innerHTML = `
      <label class="field">
        <span>Nome da aba</span>
        <input type="text" id="sLabel" value="${esc(s.label || "")}" placeholder="Cardápio de Comida" />
      </label>
      <div class="field-row">
        <label class="field">
          <span>Ícone</span>
          <input type="text" id="sIcone" value="${esc(s.icon || "")}" maxlength="4" placeholder="🍽️" />
          <span class="field-hint">Um emoji só. No teclado do tablet fica na carinha 😀.</span>
        </label>
        <label class="field">
          <span>Ordem</span>
          <input type="number" id="sOrdem" value="${esc(s.sort_order || 0)}" min="0" step="1" />
          <span class="field-hint">Número menor aparece antes.</span>
        </label>
      </div>
      <label class="switch">
        <input type="checkbox" id="sAtiva"${s.active ? " checked" : ""} />
        <span class="trilho"></span>
        <span>Aba ligada (aparece para o quiosque)</span>
      </label>
      <div class="aviso aviso-info" style="font-weight:400;font-size:.88rem">
        <div>
          Tipo desta aba: <b>${s.kind === "tips" ? "conteúdo (dicas)" : "com produtos e carrinho"}</b>.<br>
          Chave interna: <b>${esc(s.key)}</b> — essa chave vai gravada em cada item vendido,
          por isso ela não muda depois de criada. O nome e o ícone você troca à vontade.
        </div>
      </div>
      <button type="button" class="btn btn-primary" id="sSalvar" style="min-height:48px">Salvar esta aba</button>`;

    PL.$("#sSalvar", caixa).onclick = async function () {
      var botao = PL.$("#sSalvar", caixa);
      var rotulo = val(caixa, "sLabel");
      if (!rotulo) { PL.aviso("Escreva o nome da aba.", "avisa"); return; }
      botao.disabled = true;
      await tentar(async function () {
        var linha = {
          id: s.id,
          label: rotulo,
          icon: val(caixa, "sIcone"),
          active: marcado(caixa, "sAtiva"),
          sort_order: Number(val(caixa, "sOrdem")) || 0,
        };
        await PL.backend.salvar("secoes", linha);
        await PL.recarregarCatalogo();
      }, "Salvo!");
      botao.disabled = false;

      // o título do pop-up é o nome da aba: se mudou, muda ali em cima também
      var nova = daSecao();
      var tit = api && api.fundo ? PL.$(".modal-head h2", api.fundo) : null;
      if (tit) tit.textContent = (nova.icon ? nova.icon + " " : "") + nova.label;
      desenharEditaSecao(corpo, daSecao, api);
    };
  }

  // ------------------------------------------------------------------
  //  PAINEL · PEDIDOS  (o semáforo do quadro da recepção)
  // ------------------------------------------------------------------
  function desenharAjustesPedidos(corpo) {
    var caixa = PL.$("#cfg-pedidos", corpo);
    if (!caixa) return;
    var c = (PL.ctx && PL.ctx.cliente) || {};
    caixa.innerHTML = `
        <p class="hint" style="margin:0;line-height:1.6">
          O relógio de cada cartão conta desde a hora em que o quiosque mandou o pedido.
          Estes dois números decidem quando o cartão muda de cor — é o semáforo da recepção.
        </p>
        <div class="field-row">
          <label class="field">
            <span>Minutos para “atenção”</span>
            <input type="number" id="slaAtencao" min="1" max="180" step="1"
                   value="${esc(c.sla_warn_minutes || 5)}" />
            <span class="field-hint">Passou disso, o cartão fica <b>âmbar</b>: está demorando.</span>
          </label>
          <label class="field">
            <span>Minutos para “atrasado”</span>
            <input type="number" id="slaAtraso" min="2" max="240" step="1"
                   value="${esc(c.sla_late_minutes || 12)}" />
            <span class="field-hint">Passou disso, fica <b>vermelho e pisca</b>: alguém precisa olhar agora.</span>
          </label>
        </div>
        <div class="aviso aviso-info" style="font-weight:400;font-size:.88rem">
          <div>
            Vale para todos os tablets ao mesmo tempo — o valor fica guardado na nuvem,
            não neste aparelho. Um número baixo demais deixa o quadro sempre vermelho e
            as pessoas param de olhar para a cor.
          </div>
        </div>
        <button type="button" class="btn btn-primary" id="slaSalvar" style="min-height:48px">Salvar</button>`;

    PL.$("#slaSalvar", caixa).onclick = async function () {
      var botao = PL.$("#slaSalvar", caixa);
      var atencao = Number(val(caixa, "slaAtencao")) || 0;
      var atraso = Number(val(caixa, "slaAtraso")) || 0;
      if (atencao < 1 || atraso < 1) { PL.aviso("Os dois números precisam ser pelo menos 1 minuto.", "avisa"); return; }
      if (atraso <= atencao) { PL.aviso("O “atrasado” precisa ser maior que o “atenção”.", "avisa"); return; }

      botao.disabled = true;
      await tentar(async function () {
        var campos = { sla_warn_minutes: atencao, sla_late_minutes: atraso };
        await PL.backend.salvarCliente(campos);
        atualizarClienteNaMemoria(campos);
      }, "Salvo!");
      botao.disabled = false;
    };
  }

  // ==================================================================
  //  O PAINEL DE CONFIGURAÇÕES  (um só, separado por página)
  //  ------------------------------------------------------------------
  //  Antes cada engrenagem abria um pop-up diferente, e para trocar um
  //  preço e depois o horário era preciso fechar tudo e recomeçar. Agora
  //  existe UMA janela com uma aba por página do app: a engrenagem só
  //  decide em qual aba ela abre.
  //
  //  PLAdmin.abrir()               → abre na primeira aba
  //  PLAdmin.abrir('pedidos')      → abre nos ajustes do quadro
  //  PLAdmin.abrir('cardapio', s)  → abre no cardápio e já entra na aba s
  // ==================================================================
  var ABAS_PAINEL = [
    { id: "casa",      rotulo: "Estabelecimento", desenhar: desenharCasa },
    { id: "cardapio",  rotulo: "Cardápio",        desenhar: desenharAbasDoQuiosque },
    { id: "pedidos",   rotulo: "Pedidos",         desenhar: desenharAjustesPedidos },
    { id: "quiosques", rotulo: "Quiosques",       desenhar: desenharQuiosques },
    { id: "equipe",    rotulo: "Equipe",          desenhar: desenharEquipe },
    { id: "sobre",     rotulo: "Sobre",           desenhar: desenharSobre },
  ];

  // Cada aba entrega só uma div vazia; quem preenche é o 'desenhar', tanto
  // na abertura quanto a cada troca. Assim uma gravação numa aba não deixa
  // as outras mostrando dado velho.
  function abrirPainel(abaInicial, extra) {
    var quais = ABAS_PAINEL.slice();
    var i = 0;
    quais.forEach(function (a, n) { if (a.id === abaInicial) i = n; });
    // a aba pedida vai para a frente: o núcleo sempre abre a primeira
    if (i > 0) quais.unshift(quais.splice(i, 1)[0]);

    var painel = modalComAbas({
      titulo: "Configurações",
      larga: true,
      abas: quais.map(function (a) {
        return {
          id: a.id,
          rotulo: a.rotulo,
          corpo: '<div id="cfg-' + a.id + '"></div>',
          aoAbrir: function (corpo) { a.desenhar(corpo); },
        };
      }),
      // ao fechar, a tela de trás precisa aparecer já com o que mudou
      aoFechar: function () { PL.recarregarTela(); },
    });

    // Veio da engrenagem do cardápio com uma aba do quiosque em mãos:
    // abre o editor dela por cima, que é o que o admin queria ver.
    if (abaInicial === "cardapio" && extra && extra.id) {
      setTimeout(function () { configurarSecao(extra); }, 60);
    }
    return painel;
  }

  // ------------------------------------------------------------------
  //  GERAL · ESTABELECIMENTO
  // ------------------------------------------------------------------
  function desenharCasa(corpo) {
    var caixa = PL.$("#cfg-casa", corpo);
    if (!caixa) return;
    var c = (PL.ctx && PL.ctx.cliente) || {};
    var fusoAtual = c.timezone || "America/Sao_Paulo";
    var listaFusos = FUSOS.indexOf(fusoAtual) >= 0 ? FUSOS : [fusoAtual].concat(FUSOS);

    caixa.innerHTML = `
      <label class="field">
        <span>Nome que aparece no topo</span>
        <input type="text" id="tNome" value="${esc(c.name || "")}" placeholder="Pedidos Lagoa" />
      </label>
      <label class="field">
        <span>Nome do lugar (o subtítulo)</span>
        <input type="text" id="tRazao" value="${esc(c.legal_name || "")}" placeholder="Pesqueiro Lagoa Azul" />
      </label>
      <label class="field">
        <span>Endereço do logotipo</span>
        <input type="url" id="tLogo" value="${esc(c.logo_url || "")}" placeholder="https://…/logo.png" />
        <span class="field-hint">Quadrado, fundo transparente, pelo menos 192 pixels.</span>
      </label>

      <div class="field-row">
        <label class="field">
          <span>Cor principal</span>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="color" id="corPrim" value="${esc(corSegura(c.primary_color, "#0E5C63"))}"
                   style="width:56px;height:48px;padding:2px;border:1.5px solid var(--line);border-radius:12px;background:#fff" />
            <input type="text" id="corPrimTxt" value="${esc(c.primary_color || "#0E5C63")}" placeholder="#0E5C63" />
          </div>
          <span class="field-hint">Cabeçalho e botões principais.</span>
        </label>
        <label class="field">
          <span>Cor de destaque</span>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="color" id="corAcc" value="${esc(corSegura(c.accent_color, "#F4A024"))}"
                   style="width:56px;height:48px;padding:2px;border:1.5px solid var(--line);border-radius:12px;background:#fff" />
            <input type="text" id="corAccTxt" value="${esc(c.accent_color || "#F4A024")}" placeholder="#F4A024" />
          </div>
          <span class="field-hint">O que pede ação: carrinho, pedido novo.</span>
        </label>
      </div>

      <label class="field">
        <span>Fuso horário</span>
        <select id="tFuso">
          ${listaFusos.map(function (f) {
            return `<option value="${esc(f)}"${f === fusoAtual ? " selected" : ""}>${esc(f)}</option>`;
          }).join("")}
        </select>
        <span class="field-hint">
          É por ele que o sistema sabe quando vira o dia e reinicia a numeração dos pedidos (#1, #2…).
        </span>
      </label>

      <button type="button" class="btn btn-primary" id="tSalvar" style="min-height:48px">Salvar e aplicar as cores</button>`;

    // os dois campos de cor andam juntos: o seletor é para escolher no dedo,
    // o texto é para colar o código exato que veio do designer
    ligarCor(caixa, "corPrim", "corPrimTxt");
    ligarCor(caixa, "corAcc", "corAccTxt");

    PL.$("#tSalvar", caixa).onclick = async function () {
      var botao = PL.$("#tSalvar", caixa);
      var nome = val(caixa, "tNome");
      if (!nome) { PL.aviso("O nome não pode ficar vazio.", "avisa"); return; }
      botao.disabled = true;
      await tentar(async function () {
        var campos = {
          name: nome,
          legal_name: val(caixa, "tRazao") || null,
          logo_url: val(caixa, "tLogo") || null,
          primary_color: corSegura(val(caixa, "corPrimTxt"), "#0E5C63"),
          accent_color: corSegura(val(caixa, "corAccTxt"), "#F4A024"),
          timezone: val(caixa, "tFuso") || "America/Sao_Paulo",
        };
        await PL.backend.salvarCliente(campos);
        atualizarClienteNaMemoria(campos);
        // repinta na hora: sem isto o admin só veria as cores novas no
        // próximo login e acharia que não salvou
        PL.aplicarTema(PL.ctx.cliente);
      }, "Salvo!");
      botao.disabled = false;
    };
  }

  // Aceita "#0E5C63" e "0E5C63"; qualquer outra coisa volta para o padrão —
  // uma cor inválida quebraria o degradê do cabeçalho.
  function corSegura(valor, padrao) {
    var s = String(valor || "").trim();
    if (/^#?[0-9a-fA-F]{6}$/.test(s)) return s[0] === "#" ? s : "#" + s;
    if (/^#?[0-9a-fA-F]{3}$/.test(s)) {
      var h = s.replace("#", "");
      return "#" + h.split("").map(function (x) { return x + x; }).join("");
    }
    return padrao;
  }

  function ligarCor(caixa, idCor, idTexto) {
    var cor = PL.$("#" + idCor, caixa);
    var txt = PL.$("#" + idTexto, caixa);
    if (!cor || !txt) return;
    cor.oninput = function () { txt.value = cor.value; };
    txt.oninput = function () { cor.value = corSegura(txt.value, cor.value); };
  }

  // ------------------------------------------------------------------
  //  GERAL · ABAS DO QUIOSQUE
  // ------------------------------------------------------------------
  function desenharAbasDoQuiosque(corpo) {
    var caixa = PL.$("#cfg-cardapio", corpo);
    if (!caixa) return;
    var secoes = porOrdem(PL.catalogo.secoes);

    caixa.innerHTML = `
      <div class="card-head">
        <span class="hint">Estas são as abas que o tablet do quiosque mostra, nesta ordem.</span>
        <button type="button" class="btn btn-sm btn-primary" data-acao="nova" style="min-height:44px">+ Nova aba</button>
      </div>
      ${secoes.length ? `<div class="lista-edit">${secoes.map(function (s) {
        var quantos = s.kind === "tips"
          ? PL.catalogo.dicas.filter(function (d) { return d.section_id === s.id; }).length + " dica(s)"
          : PL.catalogo.produtos.filter(function (p) { return p.section_id === s.id; }).length + " produto(s)";
        return linhaEdit({
          id: s.id,
          inativo: !s.active,
          nome: `${s.icon ? esc(s.icon) + " " : ""}${esc(s.label)}`,
          sub: `${quantos} · chave: ${esc(s.key)}${s.active ? "" : " · desligada"}`,
          reordena: true,
          chaveSwitch: "ativa",
          rotuloSwitch: "Ligada",
          dicaSwitch: "Desligada, a aba some do tablet do quiosque sem apagar nada.",
          ligado: !!s.active,
          botoes: [
            { acao: "conteudo", texto: "Produtos/Dicas", classe: "btn-primary", dica: "Abrir o editor desta aba" },
            { acao: "editar", texto: "Editar", classe: "btn-outline" },
            { acao: "excluir", texto: "Excluir", classe: "btn-danger" },
          ],
        });
      }).join("")}</div>` : `<div class="vazio"><b>Nenhuma aba criada</b>Sem aba, o tablet do quiosque abre vazio.</div>`}
    `;

    ligarAcoes(caixa, async function (acao, id, alvo) {
      var s = secoes.find(function (x) { return x.id === id; });

      if (acao === "nova") { formularioSecao(null, function () { desenharAbasDoQuiosque(corpo); }); return; }
      if (acao === "editar" && s) { formularioSecao(s, function () { desenharAbasDoQuiosque(corpo); }); return; }
      if (acao === "conteudo" && s) { configurarSecao(s); return; }

      if (acao === "ativa" && s) {
        var querido = alvo.checked;
        var ok = await tentar(function () { return PL.backend.salvar("secoes", { id: s.id, active: querido }); }, "Salvo!");
        if (!ok) alvo.checked = !querido;
        await PL.recarregarCatalogo();
        desenharAbasDoQuiosque(corpo);
        return;
      }

      if (acao === "subir" || acao === "descer") {
        var ids = idsTrocando(secoes, id, acao === "subir" ? -1 : 1);
        if (!ids) return;
        await tentar(function () { return PL.backend.reordenar("secoes", ids); });
        await PL.recarregarCatalogo();
        desenharAbasDoQuiosque(corpo);
        return;
      }

      if (acao === "excluir" && s) {
        var prods = PL.catalogo.produtos.filter(function (p) { return p.section_id === s.id; }).length;
        var cats = PL.catalogo.categorias.filter(function (c) { return c.section_id === s.id; }).length;
        var dcs = PL.catalogo.dicas.filter(function (d) { return d.section_id === s.id; }).length;
        var certeza = await PL.confirmar({
          titulo: "Excluir a aba " + s.label,
          texto: `Isso apaga junto <b>tudo que está dentro dela</b>:
                  ${prods} produto(s), ${cats} categoria(s) e ${dcs} dica(s). Não dá para desfazer.<br><br>
                  <b>Os pedidos já feitos não mudam</b> — cada item guardou o nome e o preço da época.<br><br>
                  Se é só para tirar do tablet por um tempo, desligue o botão <b>“Ligada”</b>.`,
          ok: "Excluir a aba inteira", perigo: true,
        });
        if (!certeza) return;
        await tentar(function () { return PL.backend.remover("secoes", s.id); }, "Aba excluída.");
        await PL.recarregarCatalogo();
        desenharAbasDoQuiosque(corpo);
      }
    });
  }

  function formularioSecao(secao, aoTerminar) {
    var novo = !secao;
    var s = secao || {};
    abrirFormulario({
      titulo: novo ? "Nova aba do quiosque" : "Editar aba",
      corpo: `
        <label class="field">
          <span>Nome da aba</span>
          <input type="text" id="nsLabel" value="${esc(s.label || "")}" placeholder="Cardápio de Comida" />
        </label>
        <div class="field-row">
          <label class="field">
            <span>Ícone</span>
            <input type="text" id="nsIcone" value="${esc(s.icon || "")}" maxlength="4" placeholder="🍽️" />
            <span class="field-hint">Um emoji só.</span>
          </label>
          ${novo ? `
          <label class="field">
            <span>Tipo da aba</span>
            <select id="nsTipo">
              <option value="catalog">Com produtos (tem carrinho)</option>
              <option value="tips">Só conteúdo (dicas, avisos)</option>
            </select>
          </label>` : `
          <label class="field">
            <span>Tipo da aba</span>
            <input type="text" value="${s.kind === "tips" ? "Só conteúdo (dicas)" : "Com produtos (tem carrinho)"}" disabled />
            <span class="field-hint">O tipo não muda depois de criada.</span>
          </label>`}
        </div>
        <label class="switch">
          <input type="checkbox" id="nsAtiva"${novo || s.active ? " checked" : ""} />
          <span class="trilho"></span>
          <span>Aba ligada (aparece para o quiosque)</span>
        </label>
        <div class="aviso aviso-info" style="font-weight:400;font-size:.88rem">
          <div id="nsAvisoChave">
            ${novo
              ? `A <b>chave</b> da aba é criada do nome (minúsculo, sem acento e sem espaço) e
                 vai gravada em cada item vendido. Por isso ela <b>não deve mudar depois</b>:
                 se mudasse, os relatórios antigos deixariam de encontrar as vendas desta aba.`
              : `Chave desta aba: <b>${esc(s.key)}</b>. Ela fica como está de propósito — os itens
                 já vendidos apontam para ela.`}
          </div>
        </div>`,
      aoAbrir: function (corpo) {
        if (!novo) return;
        // mostra a chave que vai ser criada enquanto a pessoa digita o nome:
        // é mais fácil aceitar uma regra quando dá para ver o resultado
        var campoNome = PL.$("#nsLabel", corpo);
        var aviso = PL.$("#nsAvisoChave", corpo);
        campoNome.oninput = function () {
          aviso.innerHTML = `A chave desta aba vai ser <b>${esc(chaveDoTexto(campoNome.value))}</b>.
            Ela vai gravada em cada item vendido e <b>não deve mudar depois</b>.`;
        };
      },
      aoSalvar: async function (corpo) {
        var rotulo = val(corpo, "nsLabel");
        if (!rotulo) { PL.aviso("Escreva o nome da aba.", "avisa"); return false; }

        var linha = {
          label: rotulo,
          icon: val(corpo, "nsIcone"),
          active: marcado(corpo, "nsAtiva"),
        };
        if (novo) {
          linha.key = chaveDoTexto(rotulo);
          linha.kind = val(corpo, "nsTipo") || "catalog";
          linha.sort_order = proximaOrdem(PL.catalogo.secoes);
          if (PL.catalogo.secoes.some(function (x) { return x.key === linha.key; })) {
            PL.aviso("Já existe uma aba com esse nome. Escolha outro.", "avisa");
            return false;
          }
        } else {
          linha.id = s.id;
        }
        await PL.backend.salvar("secoes", linha);
        await PL.recarregarCatalogo();
        if (aoTerminar) aoTerminar();
      },
    });
  }

  // ------------------------------------------------------------------
  //  GERAL · QUIOSQUES
  // ------------------------------------------------------------------
  function desenharQuiosques(corpo) {
    var caixa = PL.$("#cfg-quiosques", corpo);
    if (!caixa) return;
    var quiosques = PL.catalogo.quiosques.slice().sort(function (a, b) {
      return (Number(a.number) || 0) - (Number(b.number) || 0);
    });

    var ativos = quiosques.filter(function (q) { return q.active !== false; });

    caixa.innerHTML = `
      <div class="card-head">
        <span class="hint">${quiosques.length} quiosque(s). Cada um tem o seu login (quiosque1, quiosque2…).</span>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="btn btn-sm btn-outline" data-acao="folha"
                  style="min-height:44px" ${ativos.length ? "" : "disabled"}>🖨️ Folha de QR codes</button>
          <button type="button" class="btn btn-sm btn-primary" data-acao="novo" style="min-height:44px">+ Novo quiosque</button>
        </div>
      </div>

      <div class="aviso aviso-info" style="font-weight:400;font-size:.88rem">
        <div>
          O <b>QR code</b> de cada quiosque leva o cliente direto ao cardápio, <b>sem senha</b>.
          Cole no balcão. O QR não carrega senha nenhuma — quem impede o pedido de longe
          é a <b>área abaixo</b>.
        </div>
      </div>

      <div id="cercoLagoa"></div>

      ${quiosques.length ? `<div class="lista-edit">${quiosques.map(function (q) {
        var partes = [];
        if (q.location_note) partes.push(q.location_note);
        if (q.phone) partes.push("☎ " + q.phone);
        if (!q.active) partes.push("desativado");
        return linhaEdit({
          id: q.id,
          inativo: !q.active,
          nome: `<b style="color:var(--brand-dark)">#${esc(q.number)}</b> ${esc(q.name)}`,
          sub: partes.length ? esc(partes.join(" · ")) : "sem observação de lugar",
          chaveSwitch: "ativo",
          rotuloSwitch: "Ativo",
          dicaSwitch: "Desativado, ele some das listas — mas os pedidos antigos dele continuam no histórico.",
          ligado: !!q.active,
          botoes: [
            { acao: "qr", texto: "QR", classe: "btn-neutral", dica: "Ver e baixar o QR code deste quiosque" },
            { acao: "editar", texto: "Editar", classe: "btn-outline" },
          ],
        });
      }).join("")}</div>` : `<div class="vazio"><b>Nenhum quiosque cadastrado</b>Sem quiosque ninguém consegue mandar pedido.</div>`}
      <p class="hint" style="line-height:1.6">
        Quiosque não se exclui, se <b>desativa</b>: os pedidos já feitos apontam para ele e o
        histórico ficaria com buracos. Desativado, ele simplesmente some das listas.
      </p>`;

    ligarAcoes(caixa, async function (acao, id, alvo) {
      var q = quiosques.find(function (x) { return x.id === id; });

      if (acao === "folha") { folhaDeQrCodes(ativos); return; }
      if (acao === "qr" && q) { verQrCode(q); return; }
      if (acao === "aqui")   { marcarLocalAtual(corpo); return; }
      if (acao === "salvarCerco") { salvarCerco(corpo); return; }
      if (acao === "limparCerco") { limparCerco(corpo); return; }
      if (acao === "novo") { formularioQuiosque(null, quiosques, function () { desenharQuiosques(corpo); }); return; }
      if (acao === "editar" && q) { formularioQuiosque(q, quiosques, function () { desenharQuiosques(corpo); }); return; }

      if (acao === "ativo" && q) {
        var querido = alvo.checked;
        var ok = await tentar(function () { return PL.backend.salvar("quiosques", { id: q.id, active: querido }); }, "Salvo!");
        if (!ok) alvo.checked = !querido;
        await PL.recarregarCatalogo();
        desenharQuiosques(corpo);
      }
    });

    desenharCerco(corpo);
  }

  // ==================================================================
  //  A ÁREA DA LAGOA  (a trava do pedido pelo QR)
  //  ------------------------------------------------------------------
  //  Um QR fixo é um link impresso, e link se copia: quem escaneia pode
  //  salvar e tentar pedir de casa. O celular manda a localização junto
  //  com o pedido, e o BANCO confere se ela cai dentro deste círculo —
  //  não é checagem de tela, que qualquer um contorna.
  //
  //  O jeito de marcar o ponto é o único que funciona sem mapa: o dono
  //  abre isto aqui DE PÉ NA LAGOA e toca em "estou aqui agora".
  // ==================================================================
  function desenharCerco(corpo) {
    var caixa = PL.$("#cercoLagoa", corpo);
    if (!caixa) return;
    var c = (PL.ctx && PL.ctx.cliente) || {};
    var temPonto = c.geo_lat !== null && c.geo_lat !== undefined && c.geo_lat !== "";
    var raio = Number(c.geo_radius_m) || 250;

    caixa.innerHTML = `
      <div class="card" style="padding:16px;margin-bottom:14px">
        <h3 class="card-title">📍 Área de pedido pelo QR</h3>

        ${temPonto ? `
          <div class="aviso aviso-info" style="font-weight:400;font-size:.88rem">
            <div>
              Ponto marcado: <b>${esc(Number(c.geo_lat).toFixed(5))}, ${esc(Number(c.geo_lng).toFixed(5))}</b>
              · raio de <b>${esc(raio)} m</b>.<br>
              Quem estiver fora disso não consegue enviar pedido pelo celular.
            </div>
          </div>` : `
          <div class="aviso aviso-warn" style="font-weight:400;font-size:.88rem">
            <div>
              <b>A área ainda não foi marcada.</b> Enquanto isso, o pedido pelo QR
              funciona de qualquer lugar. Abra esta tela <b>de pé na lagoa</b> e toque
              no botão abaixo.
            </div>
          </div>`}

        <div style="display:flex;gap:10px;flex-wrap:wrap;margin:12px 0">
          <button type="button" class="btn btn-primary" data-acao="aqui" style="min-height:48px">
            📍 Estou aqui agora — usar este ponto
          </button>
          ${temPonto ? `<button type="button" class="btn btn-danger btn-sm" data-acao="limparCerco"
             style="min-height:48px">Desligar a trava</button>` : ""}
        </div>
        <p class="form-msg" id="cercoMsg" role="status"></p>

        <div class="field-row">
          <label class="field">
            <span>Raio (metros)</span>
            <input type="number" id="cercoRaio" min="30" max="5000" step="10" value="${esc(raio)}" />
            <span class="field-hint">
              Do centro até a cerca. 250 m cobre um sítio inteiro; menos que 100 m
              começa a recusar cliente por causa da imprecisão do próprio GPS.
            </span>
          </label>
          <label class="field">
            <span>Máximo de pedidos por quiosque</span>
            <input type="number" id="cercoTeto" min="1" max="60" step="1"
                   value="${esc(Number(c.public_max_10min) || 10)}" />
            <span class="field-hint">A cada 10 minutos. Freio contra brincadeira.</span>
          </label>
        </div>

        <label class="switch" style="margin:6px 0">
          <input type="checkbox" id="cercoLigado" ${c.public_orders_enabled === false ? "" : "checked"} />
          <span class="trilho"></span>
          <span>Aceitar pedidos pelo QR code</span>
        </label>
        <span class="field-hint" style="display:block;margin:-4px 0 10px">
          Desligue para fechar o pedido pelo celular sem tirar os adesivos da parede.
        </span>

        <div class="campos-manuais" style="margin-bottom:12px">
          <details>
            <summary class="hint" style="cursor:pointer">Digitar as coordenadas à mão</summary>
            <div class="field-row" style="margin-top:10px">
              <label class="field">
                <span>Latitude</span>
                <input type="text" id="cercoLat" inputmode="decimal"
                       value="${temPonto ? esc(c.geo_lat) : ""}" placeholder="-23.55052" />
              </label>
              <label class="field">
                <span>Longitude</span>
                <input type="text" id="cercoLng" inputmode="decimal"
                       value="${temPonto ? esc(c.geo_lng) : ""}" placeholder="-46.63331" />
              </label>
            </div>
            <span class="field-hint">
              No Google Maps: clique com o botão direito no ponto da lagoa — os dois
              números aparecem no topo do menu, prontos para copiar.
            </span>
          </details>
        </div>

        <button type="button" class="btn btn-primary" data-acao="salvarCerco" style="min-height:48px">
          Salvar área
        </button>
      </div>`;
  }

  function marcarLocalAtual(corpo) {
    var msg = PL.$("#cercoMsg", corpo);
    if (msg) { msg.className = "form-msg"; msg.textContent = "Procurando o sinal do GPS…"; }

    PL.ondeEstou().then(function (onde) {
      if (!onde.lat) {
        if (msg) {
          msg.className = "form-msg";
          msg.textContent = "Não consegui a localização. Permita o acesso no navegador " +
            "e tente de novo — ou digite as coordenadas à mão.";
        }
        return;
      }
      var lat = PL.$("#cercoLat", corpo);
      var lng = PL.$("#cercoLng", corpo);
      if (lat) lat.value = onde.lat;
      if (lng) lng.value = onde.lng;
      if (msg) {
        msg.className = "form-msg ok";
        msg.textContent = "Ponto capturado (precisão de ~" + Math.round(onde.precisao || 0) +
          " m). Confira o raio e toque em Salvar área.";
      }
      // se o GPS veio ruim, um raio apertado recusaria gente de pé no balcão
      var raio = PL.$("#cercoRaio", corpo);
      if (raio && onde.precisao > Number(raio.value)) {
        raio.value = Math.ceil((onde.precisao * 2) / 10) * 10;
      }
    });
  }

  async function salvarCerco(corpo) {
    var lat = val(corpo, "cercoLat").replace(",", ".");
    var lng = val(corpo, "cercoLng").replace(",", ".");
    var raio = Number(val(corpo, "cercoRaio")) || 0;
    var teto = Number(val(corpo, "cercoTeto")) || 0;
    var ligado = marcado(corpo, "cercoLigado");

    if (raio < 30 || raio > 5000) { PL.aviso("O raio precisa ficar entre 30 e 5000 metros.", "avisa"); return; }
    if (teto < 1) { PL.aviso("O máximo de pedidos precisa ser pelo menos 1.", "avisa"); return; }

    var campos = {
      geo_radius_m: Math.round(raio),
      public_max_10min: Math.round(teto),
      public_orders_enabled: ligado,
    };

    if (lat && lng) {
      var nLat = Number(lat), nLng = Number(lng);
      if (!isFinite(nLat) || !isFinite(nLng) || Math.abs(nLat) > 90 || Math.abs(nLng) > 180) {
        PL.aviso("Coordenadas inválidas. Confira a latitude e a longitude.", "avisa");
        return;
      }
      campos.geo_lat = nLat;
      campos.geo_lng = nLng;
      campos.geo_required = true;
    }

    await tentar(async function () {
      await PL.backend.salvarCliente(campos);
      atualizarClienteNaMemoria(campos);
    }, "Área salva!");
    desenharCerco(corpo);
  }

  async function limparCerco(corpo) {
    var certeza = await PL.confirmar({
      titulo: "Desligar a trava de localização",
      texto: `Sem a área marcada, <b>qualquer pessoa que tenha o link consegue pedir de onde estiver</b> —
              inclusive de casa, dias depois de escanear o adesivo.<br><br>
              A recepção continua vendo todo pedido antes de lançar, mas ela passa a ser a única defesa.`,
      ok: "Desligar mesmo assim", perigo: true,
    });
    if (!certeza) return;

    var campos = { geo_lat: null, geo_lng: null, geo_required: false };
    await tentar(async function () {
      await PL.backend.salvarCliente(campos);
      atualizarClienteNaMemoria(campos);
    }, "Trava desligada.");
    desenharCerco(corpo);
  }

  // ==================================================================
  //  QR CODE DE CADA QUIOSQUE
  //  Gerado aqui dentro, pelo qr.js — sem serviço na internet. Isso
  //  importa: um QR feito por site de terceiro deixaria o endereço da
  //  casa passando por um servidor que não é nosso, e pararia de
  //  funcionar no dia em que aquele site saísse do ar.
  // ==================================================================
  function svgDoQr(texto) {
    if (!window.QRCode || typeof window.QRCode.svg !== "function") return null;
    try { return window.QRCode.svg(texto, { margin: 2, dark: "#0E1D1F", light: "#ffffff" }); }
    catch (e) { console.warn("QR:", e); return null; }
  }

  // O QR do balcão leva o CÓDIGO do quiosque (?k=...), não o número:
  // é ele que abre o cardápio direto para o cliente, sem senha. Um
  // quiosque sem código ainda não passou pelo 07-pedido-publico.sql.
  function linkDoCliente(q) {
    return q.public_token ? PL.enderecoDoCliente(q.public_token) : null;
  }

  function verQrCode(q) {
    var url = linkDoCliente(q);
    if (!url) {
      PL.aviso("Este quiosque ainda não tem código de QR. Rode o 07-pedido-publico.sql no Supabase.", "erro");
      return;
    }
    var svg = svgDoQr(url);

    if (!svg) {
      PL.aviso("Não consegui gerar o QR code. Confira se o arquivo qr.js foi publicado.", "erro");
      return;
    }

    PL.modal({
      titulo: "QR code · " + (q.name || "Quiosque " + q.number),
      corpo: `
        <div style="text-align:center">
          <div style="width:min(70vw,260px);margin:0 auto 12px">${svg}</div>
          <div style="font-size:1.3rem;font-weight:800;color:var(--brand-dark)">${esc(q.name || "Quiosque " + q.number)}</div>
          <p class="hint" style="word-break:break-all;margin:8px 0 0">${esc(url)}</p>
        </div>
        <div class="aviso aviso-info" style="font-weight:400;font-size:.86rem">
          <div>
            Imprima, plastifique e cole no balcão do <b>${esc(q.name || "Quiosque " + q.number)}</b>.
            O cliente aponta a câmera e já cai no cardápio — <b>sem senha</b>.
            O pedido só é aceito se ele estiver dentro da área da lagoa.
          </div>
        </div>`,
      botoes: [
        { texto: "Copiar endereço", classe: "btn-neutral", acao: function () { copiarTexto(url); } },
        { texto: "⬇ Baixar PNG", classe: "btn-outline",
          acao: function () { baixarQrPng(svg, q); } },
        { texto: "🖨️ Imprimir", classe: "btn-primary",
          acao: function (fechar) { fechar(); folhaDeQrCodes([q]); } },
      ],
    });
  }

  // O SVG vira PNG no próprio navegador: um canvas, o desenho por cima e
  // pronto. Sem isso o dono teria um arquivo que o WhatsApp não abre.
  function baixarQrPng(svg, q) {
    var LADO = 900;
    var RODAPE = 150;
    try {
      var img = new Image();
      var fonte = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);

      img.onload = function () {
        var cv = document.createElement("canvas");
        cv.width = LADO;
        cv.height = LADO + RODAPE;
        var g = cv.getContext("2d");
        g.fillStyle = "#ffffff";
        g.fillRect(0, 0, cv.width, cv.height);
        g.drawImage(img, 0, 0, LADO, LADO);

        // o nome embaixo do código: sem ele, 17 folhas iguais viram
        // um quebra-cabeça na hora de colar
        g.fillStyle = "#0E1D1F";
        g.textAlign = "center";
        g.font = "bold 74px Segoe UI, system-ui, Arial, sans-serif";
        g.fillText(q.name || "Quiosque " + q.number, LADO / 2, LADO + 78);
        g.font = "34px Segoe UI, system-ui, Arial, sans-serif";
        g.fillStyle = "#5B6B69";
        g.fillText("Aponte a câmera para fazer o pedido", LADO / 2, LADO + 124);

        var a = document.createElement("a");
        a.href = cv.toDataURL("image/png");
        a.download = "qr-quiosque-" + q.number + ".png";
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { a.remove(); }, 1000);
        PL.aviso("QR code baixado.", "ok");
      };

      img.onerror = function () {
        PL.aviso("Não consegui montar a imagem. Use o botão Imprimir.", "erro");
      };
      img.src = fonte;
    } catch (e) {
      console.error(e);
      PL.aviso("Não consegui baixar. Use o botão Imprimir.", "erro");
    }
  }

  // Folha pronta para imprimir: um QR por quiosque, com o nome embaixo.
  // Montamos dentro da própria página (e não numa janela nova) porque
  // tablet costuma bloquear pop-up — e aí o botão não faria nada.
  function folhaDeQrCodes(lista) {
    if (!lista || !lista.length) {
      PL.aviso("Nenhum quiosque ativo para imprimir.", "avisa");
      return;
    }
    if (!window.QRCode) {
      PL.aviso("Não consegui gerar os QR codes. Confira se o arquivo qr.js foi publicado.", "erro");
      return;
    }

    var antiga = document.getElementById("folhaQr");
    if (antiga) antiga.remove();

    var folha = document.createElement("div");
    folha.id = "folhaQr";
    folha.className = "folha-qr";
    folha.innerHTML =
      '<div class="folha-qr-topo">' +
        "<b>" + esc((PL.ctx && PL.ctx.cliente && PL.ctx.cliente.name) || "Pedidos") + "</b>" +
        "<span>Recorte e cole um em cada quiosque</span>" +
      "</div>" +
      '<div class="folha-qr-grade">' +
        lista.map(function (q) {
          var link = linkDoCliente(q);
          var svg = link ? svgDoQr(link) : null;
          return '<div class="folha-qr-item">' +
              (svg || '<div class="hint">sem código — rode o 07-pedido-publico.sql</div>') +
              "<b>" + esc(q.name || "Quiosque " + q.number) + "</b>" +
              "<span>Aponte a câmera para fazer o seu pedido</span>" +
            "</div>";
        }).join("") +
      "</div>";

    document.body.appendChild(folha);
    document.body.classList.add("imprimindo-folha");

    function limpar() {
      document.body.classList.remove("imprimindo-folha");
      var f = document.getElementById("folhaQr");
      if (f) f.remove();
      window.removeEventListener("afterprint", limpar);
    }
    window.addEventListener("afterprint", limpar);

    // alguns navegadores não disparam 'afterprint'; a rede de segurança
    // evita a folha ficar pendurada por cima do app para sempre
    setTimeout(limpar, 60000);
    setTimeout(function () { window.print(); }, 120);
  }

  function formularioQuiosque(quiosque, quiosques, aoTerminar) {
    var novo = !quiosque;
    var q = quiosque || {};
    var sugerido = 1;
    quiosques.forEach(function (x) { sugerido = Math.max(sugerido, (Number(x.number) || 0) + 1); });

    abrirFormulario({
      titulo: novo ? "Novo quiosque" : "Editar quiosque #" + q.number,
      corpo: `
        <div class="field-row">
          <label class="field">
            <span>Número</span>
            <input type="number" id="qNumero" min="1" step="1" value="${esc(novo ? sugerido : q.number)}" />
            <span class="field-hint">É o número que a recepção enxerga no cartão do pedido.</span>
          </label>
          <label class="field">
            <span>Nome</span>
            <input type="text" id="qNome" value="${esc(novo ? "Quiosque " + sugerido : (q.name || ""))}" placeholder="Quiosque 7" />
          </label>
        </div>
        <label class="field">
          <span>Onde fica (opcional)</span>
          <input type="text" id="qLugar" value="${esc(q.location_note || "")}" placeholder="Perto da ponte, lado esquerdo" />
          <span class="field-hint">Ajuda quem leva o pedido e ainda não decorou o lugar.</span>
        </label>
        <label class="field">
          <span>Telefone (opcional)</span>
          <input type="tel" id="qFone" value="${esc(q.phone || "")}" placeholder="(00) 90000-0000" />
        </label>
        <label class="switch">
          <input type="checkbox" id="qAtivo"${novo || q.active ? " checked" : ""} />
          <span class="trilho"></span>
          <span>Ativo</span>
        </label>
        ${novo ? `
        <div class="aviso aviso-warn" style="font-weight:400;font-size:.88rem">
          <div>
            Criar o quiosque aqui <b>não cria o login dele</b>. O login se cria na aba
            <b>Equipe</b>, com o comando pronto para colar no Supabase.
          </div>
        </div>` : ""}`,
      aoSalvar: async function (corpo) {
        var numero = Number(val(corpo, "qNumero")) || 0;
        var nome = val(corpo, "qNome");
        if (numero < 1) { PL.aviso("O número do quiosque precisa ser 1 ou mais.", "avisa"); return false; }
        if (!nome) { PL.aviso("Escreva o nome do quiosque.", "avisa"); return false; }
        var repetido = quiosques.some(function (x) { return x.id !== q.id && Number(x.number) === numero; });
        if (repetido) { PL.aviso("Já existe um quiosque com o número " + numero + ".", "avisa"); return false; }

        var linha = {
          number: numero, name: nome,
          location_note: val(corpo, "qLugar") || null,
          phone: val(corpo, "qFone") || null,
          active: marcado(corpo, "qAtivo"),
        };
        if (novo) linha.sort_order = numero;
        else linha.id = q.id;

        await PL.backend.salvar("quiosques", linha);
        await PL.recarregarCatalogo();
        if (aoTerminar) aoTerminar();
      },
    });
  }

  // ------------------------------------------------------------------
  //  GERAL · EQUIPE
  //  Criar usuário PELO NAVEGADOR não dá: a chave que vai no config.js é
  //  pública e, de propósito, não tem poder de mexer em auth.users. Então
  //  esta aba só MOSTRA quem existe e MONTA o comando para o admin colar
  //  no SQL Editor do Supabase.
  // ------------------------------------------------------------------
  function desenharEquipe(corpo) {
    var caixa = PL.$("#cfg-equipe", corpo);
    if (!caixa) return;

    caixa.innerHTML = `
      <div id="listaPerfis"><div class="carregando"><span class="girando"></span> Buscando a equipe…</div></div>

      <h3 class="card-title" style="margin-top:6px">Criar usuário ou trocar uma senha</h3>
      <p class="hint" style="margin:0;line-height:1.6">
        Preencha os campos e copie o comando que aparece embaixo. Depois cole no
        <b>SQL Editor</b> do Supabase e clique em <b>Run</b>. Se o login já existir,
        o comando só troca a senha — é assim que se resolve “esqueci a senha”.
      </p>

      <div class="field-row">
        <label class="field">
          <span>Login</span>
          <input type="text" id="uLogin" placeholder="quiosque18" autocapitalize="none" spellcheck="false" />
        </label>
        <label class="field">
          <span>Senha</span>
          <input type="text" id="uSenha" placeholder="mínimo 6 caracteres" autocapitalize="none" spellcheck="false" />
        </label>
      </div>
      <div class="field-row">
        <label class="field">
          <span>Papel</span>
          <select id="uPapel">
            <option value="quiosque">Quiosque (só o próprio cardápio)</option>
            <option value="recepcao">Recepção (o quadro de pedidos)</option>
            <option value="admin">Administrador (tudo)</option>
          </select>
        </label>
        <label class="field" id="uCampoQuiosque">
          <span>Número do quiosque</span>
          <input type="number" id="uQuiosque" min="1" step="1" placeholder="7" />
        </label>
        <label class="field">
          <span>Nome na tela</span>
          <input type="text" id="uNome" placeholder="Quiosque 18" />
        </label>
      </div>

      <label class="field">
        <span>Comando para colar no Supabase</span>
        <textarea id="uSql" rows="3" readonly spellcheck="false"
                  style="font-family:ui-monospace,Consolas,monospace;font-size:.86rem"></textarea>
      </label>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button type="button" class="btn btn-primary" id="uCopiar" style="min-height:48px">Copiar comando</button>
      </div>
      <div class="aviso aviso-warn" style="font-weight:400;font-size:.88rem">
        <div>
          A senha viaja em texto puro dentro desse comando. Cole no Supabase, rode e
          <b>não deixe o comando salvo</b> em bloco de notas nem em grupo de WhatsApp.
        </div>
      </div>`;

    // ---- o comando SQL, montado enquanto a pessoa digita ----
    function textoSql() {
      var papel = val(caixa, "uPapel") || "quiosque";
      var login = val(caixa, "uLogin") || "LOGIN";
      var senha = val(caixa, "uSenha") || "SENHA";
      var nome = val(caixa, "uNome") || login;
      // O número entra CRU no comando (não leva aspas), então ele não pode ser
      // texto: só um inteiro positivo passa. Sem isso, qualquer coisa digitada
      // aqui viraria parte do SQL que o admin vai colar no banco.
      var num = parseInt(val(caixa, "uQuiosque"), 10);
      var quiosque = papel === "quiosque"
        ? (num > 0 ? String(num) : "NUMERO")
        : "null";
      return "select app.criar_usuario('" + aspasSql(login) + "','" + aspasSql(senha) + "','" +
        papel + "', " + quiosque + ", '" + aspasSql(nome) + "');";
    }

    function atualizarSql() {
      var papel = val(caixa, "uPapel");
      // o campo do número só faz sentido para o papel 'quiosque'
      PL.$("#uCampoQuiosque", caixa).hidden = papel !== "quiosque";
      PL.$("#uSql", caixa).value = textoSql();
    }

    ["uLogin", "uSenha", "uPapel", "uQuiosque", "uNome"].forEach(function (id) {
      var el = PL.$("#" + id, caixa);
      if (el) { el.oninput = atualizarSql; el.onchange = atualizarSql; }
    });
    atualizarSql();

    PL.$("#uCopiar", caixa).onclick = function () { copiarTexto(textoSql()); };

    // ---- quem já existe ----
    listarPerfis(PL.$("#listaPerfis", caixa));
  }

  // Dentro de um texto do Postgres, a aspa simples se escreve dobrada.
  // Sem isto, um nome como "D'Ávila" quebraria o comando inteiro.
  function aspasSql(txt) {
    return String(txt || "").replace(/'/g, "''");
  }

  async function listarPerfis(alvo) {
    if (!alvo) return;

    if (PL.backend.tipo !== "supabase" || !PL.backend.sb) {
      alvo.innerHTML = `
        <div class="aviso aviso-warn" style="font-weight:400;font-size:.88rem">
          <div>
            No <b>modo demonstração</b> não existe lista de usuários de verdade: entra-se com
            <b>adm</b>, <b>recepcao</b> ou <b>quiosque1…17</b> e qualquer senha.
            A lista aparece aqui quando o app estiver ligado no banco.
          </div>
        </div>`;
      return;
    }

    try {
      var r = await PL.backend.sb.from("profiles").select("*").order("role");
      if (r.error) throw r.error;
      var perfis = r.data || [];
      var quiosques = PL.catalogo.quiosques;

      function nomeDoQuiosque(id) {
        var q = quiosques.find(function (x) { return x.id === id; });
        return q ? q.name : "";
      }
      var rotulo = { admin: "Administrador", recepcao: "Recepção", quiosque: "Quiosque" };

      alvo.innerHTML = `
        <h3 class="card-title">Quem tem acesso hoje (${perfis.length})</h3>
        <div class="tabela-rolagem">
          <table class="tabela">
            <thead><tr><th>Nome na tela</th><th>Papel</th><th>Quiosque</th><th>Situação</th></tr></thead>
            <tbody>
              ${perfis.map(function (p) {
                return `<tr class="${p.active ? "" : "linha-inativa"}">
                  <td>${esc(p.display_name)}</td>
                  <td>${esc(rotulo[p.role] || p.role)}</td>
                  <td>${esc(nomeDoQuiosque(p.kiosk_id))}</td>
                  <td>${p.active ? "ativo" : "desativado"}</td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>
        <p class="hint">O login (o que se digita na tela de entrada) não fica nesta tabela — ele mora na área de contas do Supabase.</p>`;
    } catch (e) {
      console.warn("Equipe:", e);
      alvo.innerHTML = `
        <div class="aviso aviso-erro" style="font-weight:400;font-size:.88rem">
          <div>Não deu para ler a lista de usuários. ${esc(PL.erroLegivel(e))}</div>
        </div>`;
    }
  }

  // ------------------------------------------------------------------
  //  GERAL · SOBRE
  // ------------------------------------------------------------------
  function desenharSobre(corpo) {
    var caixa = PL.$("#cfg-sobre", corpo);
    if (!caixa) return;
    var demo = PL.backend.tipo === "demo";
    // só o endereço do projeto. A chave NUNCA aparece aqui — mesmo sendo a
    // pública, mostrar chave em tela vira hábito ruim.
    var endereco = String(PL.CFG.supabaseUrl || "").split("?")[0];

    caixa.innerHTML = `
      <div class="tabela-rolagem">
        <table class="tabela">
          <tbody>
            <tr><td>Versão do programa</td><td><b>${esc(PL.VERSAO)}</b></td></tr>
            <tr><td>Situação</td><td><b>${demo ? "modo demonstração" : "ligado no banco"}</b></td></tr>
            <tr><td>Banco (Supabase)</td><td>${endereco ? esc(endereco) : "— não configurado —"}</td></tr>
            <tr><td>Estabelecimento</td><td>${esc((PL.ctx && PL.ctx.cliente && PL.ctx.cliente.name) || "")}</td></tr>
            <tr><td>Fuso horário</td><td>${esc((PL.ctx && PL.ctx.cliente && PL.ctx.cliente.timezone) || "")}</td></tr>
            <tr><td>Hoje, para o sistema</td><td>${esc(PL.hojeNoFuso(PL.ctx && PL.ctx.cliente ? PL.ctx.cliente.timezone : null))}</td></tr>
          </tbody>
        </table>
      </div>

      ${demo ? `
        <div class="aviso aviso-warn" style="font-weight:400;font-size:.88rem">
          <div>
            <b>Modo demonstração.</b> Tudo funciona igual, mas os dados ficam guardados
            só neste aparelho e somem se alguém limpar o navegador. Para ligar no banco,
            preencha <b>supabaseUrl</b> e <b>supabaseAnonKey</b> no arquivo <b>config.js</b>.
          </div>
        </div>
        <button type="button" class="btn btn-danger" id="limparDemo" style="min-height:48px">
          Limpar dados da demonstração
        </button>` : `
        <p class="hint" style="line-height:1.6">
          Quando algo não bate entre dois tablets, a primeira coisa a conferir é a versão:
          ela precisa ser a mesma nos dois. Se estiver diferente, feche e abra o aplicativo.
        </p>`}
    `;

    var botao = PL.$("#limparDemo", caixa);
    if (botao) {
      botao.onclick = async function () {
        var certeza = await PL.confirmar({
          titulo: "Limpar a demonstração",
          texto: `Apaga <b>tudo</b> que foi criado no modo demonstração neste aparelho:
                  pedidos, produtos, abas e configurações. Volta ao cardápio de exemplo do começo.<br><br>
                  Nada disso está no banco — é só deste tablet.`,
          ok: "Limpar tudo", perigo: true,
        });
        if (!certeza) return;
        try {
          if (PL.backend.limpar) PL.backend.limpar();
          location.reload();
        } catch (e) {
          PL.aviso(PL.erroLegivel(e), "erro");
        }
      };
    }
  }

  // ==================================================================
  //  TELA DE RELATÓRIOS
  // ==================================================================
  var diaEscolhido = null;     // aaaa-mm-dd que está sendo mostrado
  var dadosNaTela = null;      // o que foi calculado (serve para o CSV)
  var caixaRelatorio = null;   // o #conteudo desta tela (null quando saiu dela)

  PL.registrarTela({
    id: "relatorios",
    rotulo: "Relatórios",
    icone: "📊",
    ordem: 40,
    papeis: ["admin"],
    montar: montarRelatorios,
    aoSair: function () { caixaRelatorio = null; },
  });

  function montarRelatorios(container) {
    caixaRelatorio = container;
    var hoje = PL.hojeNoFuso(PL.ctx && PL.ctx.cliente ? PL.ctx.cliente.timezone : null);
    if (!diaEscolhido) diaEscolhido = hoje;

    container.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h2 class="card-title">📊 Relatório do dia</h2>
          <div class="filtros">
            <label class="hint" for="relDia">Dia</label>
            <input type="date" id="relDia" value="${esc(diaEscolhido)}" max="${esc(hoje)}" />
            <button type="button" class="btn btn-sm btn-outline" id="relHoje" style="min-height:44px">Hoje</button>
            <button type="button" class="btn btn-sm btn-outline" id="relAtualizar" style="min-height:44px">Atualizar</button>
            <button type="button" class="btn btn-sm btn-primary" id="relCsv" style="min-height:44px">Exportar CSV</button>
          </div>
        </div>
        <div id="relResumo"></div>
      </div>
      <div class="card">
        <h2 class="card-title">🏖️ Por quiosque</h2>
        <div id="relQuiosques"></div>
      </div>
      <div class="card">
        <h2 class="card-title">🔥 Mais pedidos</h2>
        <div id="relProdutos"></div>
      </div>`;

    PL.$("#relDia", container).onchange = function (e) {
      diaEscolhido = e.target.value || hoje;
      carregarRelatorio();
    };
    PL.$("#relHoje", container).onclick = function () {
      diaEscolhido = hoje;
      PL.$("#relDia", container).value = hoje;
      carregarRelatorio();
    };
    PL.$("#relAtualizar", container).onclick = carregarRelatorio;
    PL.$("#relCsv", container).onclick = exportarRelatorioCsv;

    carregarRelatorio();
  }

  // O quadro da recepção muda o tempo todo; se o relatório aberto é o de
  // hoje, ele acompanha sozinho em vez de mostrar número velho.
  PL.ao("pedidos", function () {
    if (!caixaRelatorio || !PL.telaAtiva || PL.telaAtiva.id !== "relatorios") return;
    var hoje = PL.hojeNoFuso(PL.ctx && PL.ctx.cliente ? PL.ctx.cliente.timezone : null);
    if (diaEscolhido === hoje) carregarRelatorio();
  });

  async function carregarRelatorio() {
    var container = caixaRelatorio;
    if (!container) return;
    var alvo = PL.$("#relResumo", container);
    if (alvo) alvo.innerHTML = '<div class="carregando"><span class="girando"></span> Somando os números…</div>';

    var dados = await numerosDoDia(diaEscolhido);
    if (!caixaRelatorio) return;          // trocou de tela no meio do caminho
    dadosNaTela = dados;
    desenharRelatorio(container, dados);
  }

  // Junta os números do dia. No banco de verdade eles saem prontos das views;
  // na demonstração (ou se a view falhar) são somados aqui na mão, para a
  // tela nunca ficar quebrada na frente do dono.
  async function numerosDoDia(dia) {
    var local = numerosPelosPedidos(dia);

    if (PL.backend.tipo !== "supabase") return local;

    try {
      var resumo = await PL.backend.relatorio("v_resumo_dia", { dia: dia });
      var mais = await PL.backend.relatorio("v_mais_pedidos", { dia: dia });

      // A v_resumo_dia não traz o tempo até a recepção VER o pedido; a
      // v_pedidos traz. Sem ela o cartão fica com "—" e o resto vale igual.
      var detalhe = [];
      try { detalhe = await PL.backend.relatorio("v_pedidos", { dia: dia }); }
      catch (e) { console.warn("v_pedidos:", e); }

      return numerosPelasViews(resumo || [], mais || [], detalhe || []);
    } catch (e) {
      console.warn("Relatório pelas views:", e);
      local.aviso = "Não consegui ler os relatórios do banco. Estes números foram somados no próprio tablet.";
      return local;
    }
  }

  function numerosPelasViews(resumo, mais, detalhe) {
    var d = {
      fonte: "banco", aviso: "",
      pedidos: 0, faturamento: 0, errados: 0, itens: 0,
      minLancar: null, minVer: null,
      porQuiosque: [], mais: [],
    };

    resumo.forEach(function (r) {
      d.pedidos += Number(r.pedidos || 0);
      d.faturamento += Number(r.total_cents || 0);
      d.errados += Number(r.com_erro || 0) + Number(r.cancelados || 0);
      d.itens += Number(r.itens || 0);
      d.porQuiosque.push({
        numero: Number(r.quiosque_numero || 0),
        nome: r.quiosque_nome || "",
        pedidos: Number(r.pedidos || 0),
        itens: Number(r.itens || 0),
        total_cents: Number(r.total_cents || 0),
        errados: Number(r.com_erro || 0) + Number(r.cancelados || 0),
        media: r.media_min_lancar === null || r.media_min_lancar === undefined ? null : Number(r.media_min_lancar),
      });
    });
    d.porQuiosque.sort(function (a, b) { return b.pedidos - a.pedidos || a.numero - b.numero; });

    d.mais = mais.map(function (m) {
      return {
        produto: m.produto || "", aba: m.aba || "",
        quantidade: Number(m.quantidade || 0), total_cents: Number(m.total_cents || 0),
      };
    }).sort(function (a, b) { return b.quantidade - a.quantidade || b.total_cents - a.total_cents; });

    d.minVer    = media(detalhe.map(function (p) { return p.min_ate_ver; }));
    d.minLancar = media(detalhe.map(function (p) { return p.min_ate_lancar; }));
    // sem a v_pedidos, ainda dá para ter a média pelo resumo por quiosque
    if (d.minLancar === null) {
      d.minLancar = media(d.porQuiosque.map(function (q) { return q.media; }));
    }
    return d;
  }

  // Contas na mão, a partir dos pedidos que já estão na memória.
  function numerosPelosPedidos(dia) {
    var hoje = PL.hojeNoFuso(PL.ctx && PL.ctx.cliente ? PL.ctx.cliente.timezone : null);
    var d = {
      fonte: "local", aviso: "",
      pedidos: 0, faturamento: 0, errados: 0, itens: 0,
      minLancar: null, minVer: null,
      porQuiosque: [], mais: [],
    };

    if (dia !== hoje) {
      // o app só carrega os pedidos do DIA de hoje; dias passados só saem
      // pelas views do banco
      d.aviso = "Sem o banco ligado, só dá para ver o dia de hoje.";
      return d;
    }

    var pedidos = (PL.pedidos || []).filter(function (p) { return p.service_date === dia; });
    var valem = pedidos.filter(function (p) { return p.status !== "erro" && p.status !== "cancelado"; });

    d.pedidos = pedidos.length;
    d.errados = pedidos.length - valem.length;
    d.faturamento = valem.reduce(function (s, p) { return s + Number(p.total_cents || 0); }, 0);
    d.itens = valem.reduce(function (s, p) { return s + Number(p.items_count || 0); }, 0);
    // O número que interessa: quanto o quiosque esperou entre pedir e a
    // recepção lançar. É o único tempo que o sistema controla.
    d.minLancar = media(pedidos.map(function (p) { return minutosEntre(p.created_at, p.launched_at); }));
    d.minVer    = media(pedidos.map(function (p) { return minutosEntre(p.created_at, p.ack_at); }));

    var porQ = {};
    pedidos.forEach(function (p) {
      var q = p.quiosque || PL.catalogo.quiosques.find(function (x) { return x.id === p.kiosk_id; }) || {};
      var chave = q.id || p.kiosk_id || "?";
      var linha = porQ[chave] || (porQ[chave] = {
        numero: Number(q.number || 0), nome: q.name || "Quiosque",
        pedidos: 0, itens: 0, total_cents: 0, errados: 0, tempos: [],
      });
      linha.pedidos++;
      var ruim = p.status === "erro" || p.status === "cancelado";
      if (ruim) linha.errados++;
      else {
        linha.itens += Number(p.items_count || 0);
        linha.total_cents += Number(p.total_cents || 0);
      }
      var t = minutosEntre(p.created_at, p.launched_at);
      if (t !== null) linha.tempos.push(t);
    });
    d.porQuiosque = Object.keys(porQ).map(function (k) {
      var l = porQ[k];
      l.media = media(l.tempos);
      delete l.tempos;
      return l;
    }).sort(function (a, b) { return b.pedidos - a.pedidos || a.numero - b.numero; });

    var porProduto = {};
    valem.forEach(function (p) {
      (p.itens || []).forEach(function (i) {
        var chave = i.product_name || "?";
        var l = porProduto[chave] || (porProduto[chave] = {
          produto: chave, aba: i.section_key || "", quantidade: 0, total_cents: 0,
        });
        l.quantidade += Number(i.qty || 0);
        l.total_cents += Number(i.line_total_cents || 0);
      });
    });
    d.mais = Object.keys(porProduto).map(function (k) { return porProduto[k]; })
      .sort(function (a, b) { return b.quantidade - a.quantidade || b.total_cents - a.total_cents; });

    return d;
  }

  function minutosEntre(inicio, fim) {
    if (!inicio || !fim) return null;
    var m = (new Date(fim).getTime() - new Date(inicio).getTime()) / 60000;
    return isFinite(m) && m >= 0 ? m : null;
  }

  // Média que ignora o que não aconteceu (null): um pedido que ainda não foi
  // entregue não pode puxar a média de entrega para baixo.
  function media(lista) {
    var nums = (lista || []).filter(function (n) { return n !== null && n !== undefined && isFinite(n); }).map(Number);
    if (!nums.length) return null;
    return nums.reduce(function (s, n) { return s + n; }, 0) / nums.length;
  }

  function desenharRelatorio(container, d) {
    var resumo = PL.$("#relResumo", container);
    var quios = PL.$("#relQuiosques", container);
    var prods = PL.$("#relProdutos", container);
    if (!resumo || !quios || !prods) return;

    resumo.innerHTML = `
      ${d.aviso ? `<div class="aviso aviso-warn" style="font-weight:400;font-size:.88rem;margin-bottom:12px"><div>${esc(d.aviso)}</div></div>` : ""}
      <div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
        ${cartaoNumero("Pedidos no dia", String(d.pedidos), d.itens + " item(ns)")}
        ${cartaoNumero("Faturamento", PL.dinheiro(d.faturamento), "sem os errados e cancelados")}
        ${cartaoNumero("Até a recepção ver", d.minVer === null ? "—" : PL.tempoCurto(d.minVer), "tempo médio")}
        ${cartaoNumero("Até lançar", d.minLancar === null ? "—" : PL.tempoCurto(d.minLancar), "tempo médio")}
        ${cartaoNumero("Deram errado", String(d.errados), "errados + cancelados")}
      </div>
      <p class="hint" style="margin:12px 0 0">
        Números ${d.fonte === "banco" ? "lidos do banco" : "somados neste tablet"}.
      </p>`;

    quios.innerHTML = d.porQuiosque.length ? `
      <div class="tabela-rolagem">
        <table class="tabela">
          <thead>
            <tr>
              <th>Quiosque</th><th class="num">Pedidos</th><th class="num">Itens</th>
              <th class="num">Total</th><th class="num">Errados</th><th class="num">Média até lançar</th>
            </tr>
          </thead>
          <tbody>
            ${d.porQuiosque.map(function (q) {
              return `<tr>
                <td>${q.numero ? "<b>#" + esc(q.numero) + "</b> " : ""}${esc(q.nome)}</td>
                <td class="num">${esc(q.pedidos)}</td>
                <td class="num">${esc(q.itens)}</td>
                <td class="num">${PL.dinheiro(q.total_cents)}</td>
                <td class="num">${esc(q.errados)}</td>
                <td class="num">${q.media === null ? "—" : esc(PL.tempoCurto(q.media))}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>` : `<div class="vazio"><b>Nenhum pedido neste dia</b>Escolha outro dia no calendário lá em cima.</div>`;

    prods.innerHTML = d.mais.length ? `
      <div class="tabela-rolagem">
        <table class="tabela">
          <thead>
            <tr><th>Produto</th><th>Aba</th><th class="num">Quantidade</th><th class="num">Total</th></tr>
          </thead>
          <tbody>
            ${d.mais.map(function (m) {
              return `<tr>
                <td>${esc(m.produto)}</td>
                <td>${esc(m.aba)}</td>
                <td class="num">${esc(m.quantidade)}</td>
                <td class="num">${PL.dinheiro(m.total_cents)}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
      <p class="hint" style="margin-top:10px">
        O que fica no fim desta lista dia após dia é candidato a sair do cardápio.
      </p>` : `<div class="vazio"><b>Nada vendido neste dia</b></div>`;
  }

  function cartaoNumero(rotulo, valor, dica) {
    return `
      <div class="card" style="padding:14px">
        <div class="hint">${esc(rotulo)}</div>
        <div style="font-size:1.6rem;font-weight:800;color:var(--brand-dark);line-height:1.25">${esc(valor)}</div>
        ${dica ? `<div class="hint" style="font-size:.76rem">${esc(dica)}</div>` : ""}
      </div>`;
  }

  function exportarRelatorioCsv() {
    var d = dadosNaTela;
    if (!d) { PL.aviso("Espere os números carregarem.", "avisa"); return; }

    // Os valores vão com VÍRGULA no decimal: é assim que o Excel em
    // português entende que aquilo é número e não texto.
    function reais(c) { return reaisDoCentavos(c); }
    function minutos(m) { return m === null ? "" : String(Math.round(m * 10) / 10).replace(".", ","); }

    var linhas = [];
    linhas.push(["Relatório do dia", diaEscolhido]);
    linhas.push(["Estabelecimento", (PL.ctx && PL.ctx.cliente && PL.ctx.cliente.name) || ""]);
    linhas.push([]);
    linhas.push(["Resumo", ""]);
    linhas.push(["Pedidos", d.pedidos]);
    linhas.push(["Itens", d.itens]);
    linhas.push(["Faturamento (R$)", reais(d.faturamento)]);
    linhas.push(["Deram errado", d.errados]);
    linhas.push(["Média até a recepção ver (min)", minutos(d.minVer)]);
    linhas.push(["Média até lançar (min)", minutos(d.minLancar)]);
    linhas.push([]);
    linhas.push(["Por quiosque", "", "", "", "", ""]);
    linhas.push(["Número", "Quiosque", "Pedidos", "Itens", "Total (R$)", "Errados", "Média até lançar (min)"]);
    d.porQuiosque.forEach(function (q) {
      linhas.push([q.numero || "", q.nome, q.pedidos, q.itens, reais(q.total_cents), q.errados, minutos(q.media)]);
    });
    linhas.push([]);
    linhas.push(["Mais pedidos", "", "", ""]);
    linhas.push(["Produto", "Aba", "Quantidade", "Total (R$)"]);
    d.mais.forEach(function (m) {
      linhas.push([m.produto, m.aba, m.quantidade, reais(m.total_cents)]);
    });

    baixarCsv("relatorio-" + diaEscolhido + ".csv", linhas);
    PL.aviso("Planilha baixada.", "ok");
  }

  // ==================================================================
  //  O QUE AS OUTRAS TELAS CHAMAM
  // ==================================================================
  // É por aqui que as telas chamam a engrenagem. Um ponto só: a tela diz
  // em que aba quer abrir, e o painel cuida do resto.
  window.PLAdmin.abrir = abrirPainel;
  // nomes antigos, mantidos para não quebrar nada que ainda os chame
  window.PLAdmin.configurarSecao = configurarSecao;
  window.PLAdmin.configurarGeral = function () { abrirPainel(); };

  // O 🛠 da barra de cima só avisa; quem sabe o que fazer é este arquivo.
  PL.ao("abrir-config-geral", function () { abrirPainel(); });
})();
