/* ============================================================
   PEDIDOS LAGOA — telas do QUIOSQUE
   ============================================================
   Este arquivo desenha as duas telas que ficam abertas no tablet
   de cada quiosque:

     "Cardápio"      → as abas (seções), os produtos, as dicas e
                       o carrinho que vira pedido.
     "Meus pedidos"  → o acompanhamento do que aquele quiosque
                       pediu hoje.

   Por que tudo aqui é DINÂMICO: quem manda no que aparece é o
   cadastro do banco, não este código. O administrador cria uma
   aba nova na engrenagem e ela nasce sozinha no tablet — sem
   ninguém precisar publicar o programa de novo.

   Lembrete de nomes: o que vem do banco fica em inglês
   (price_cents, kiosk_id, product_name...). Todo o resto — nome
   de função, variável e texto de tela — é em português.
   ============================================================ */
(function () {
  "use strict";

  var PL = window.PL;

  // ------------------------------------------------------------------
  //  O QUE FICA GUARDADO NO PRÓPRIO TABLET
  //  O tablet do quiosque vive ligado o dia inteiro e recarrega sozinho
  //  (atualização do programa, queda de Wi-Fi, alguém que fecha sem
  //  querer). Estas três coisas voltam do jeito que estavam para
  //  ninguém ter que refazer nada.
  // ------------------------------------------------------------------
  var CHAVE_ABA      = "pedidos_lagoa_aba";        // em que aba a pessoa estava
  var CHAVE_CARRINHO = "pedidos_lagoa_carrinho";   // o pedido que ainda não foi enviado
  var CHAVE_QUIOSQUE = "pedidos_lagoa_quiosque_admin"; // por qual quiosque o admin lança

  // Rótulo do grupo dos produtos que ficaram sem categoria. Sem isso eles
  // simplesmente sumiriam do cardápio, e ninguém entenderia o porquê.
  var SEM_CATEGORIA = "__sem_categoria__";

  // Motivos prontos para o quiosque cancelar. São diferentes dos motivos da
  // recepção (aqueles são escritos do ponto de vista de quem recebe).
  var MOTIVOS_CANCELAR = [
    "Pedi sem querer",
    "Errei o item",
    "Errei a quantidade",
    "O cliente desistiu",
  ];

  // ------------------------------------------------------------------
  //  ESTADO DAS TELAS
  //  As telas são montadas e desmontadas o tempo todo. Estas variáveis
  //  vivem no módulo (fora de montar) para sobreviver às trocas de aba.
  // ------------------------------------------------------------------
  var abaAtual = null;          // id da seção escolhida
  var carrinho = [];            // [{product_id, qty, notes}]
  var quiosqueEscolhido = null; // só o admin usa (ele não tem quiosque próprio)
  var categoriaPorSecao = {};   // qual chip está ligado em cada aba
  var observacaoGeral = "";
  var nomeCliente = "";
  var lugarPedido = "";
  var enviando = false;         // trava contra o toque duplo no tablet
  var cancelandoPedido = null;  // id do pedido cujo pop-up de cancelar está aberto

  // Como PL.ao() não tem "desligar", cada tela guarda um interruptor e todo
  // ouvinte confere se ela ainda está no ar antes de mexer em qualquer coisa.
  var telaCardapioAtiva = false;
  var telaPedidosAtiva = false;

  var areaSecao = null;   // div onde o conteúdo da aba é desenhado
  var areaAbas = null;    // faixa de abas
  var areaTopo = null;    // seletor de quiosque do admin
  var caixaPedidos = null;
  // null (e não "") de propósito: uma lista vazia também tem assinatura "",
  // e com "" aqui a tela de "nenhum pedido hoje" nunca seria desenhada.
  var assinaturaPedidos = null;  // para não redesenhar à toa a cada recarga

  // ==================================================================
  //  ATALHOS DE LEITURA DO CATÁLOGO
  //  PL.catalogo é um getter: precisa ser lido DE NOVO a cada uso, senão
  //  a tela continuaria mostrando o cardápio velho depois de o admin
  //  salvar alguma coisa.
  // ==================================================================
  function mostraPreco() {
    return PL.CFG.mostrarPreco !== false;
  }

  // Nunca ordenamos a lista original: ela é a mesma que o núcleo guarda em
  // memória, e mexer nela bagunçaria as outras telas.
  function secoesVisiveis() {
    return (PL.catalogo.secoes || [])
      .filter(function (s) { return s.active !== false; })
      .sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
  }

  function secaoAtual() {
    var lista = secoesVisiveis();
    if (!lista.length) return null;
    var achada = lista.filter(function (s) { return s.id === abaAtual; })[0];
    return achada || lista[0];
  }

  // O admin enxerga também o que está desligado (para conferir o cadastro);
  // o quiosque só vê o que está no ar.
  function produtosDaSecao(secao) {
    var admin = PL.ehAdmin();
    return (PL.catalogo.produtos || [])
      .filter(function (p) {
        return p.section_id === secao.id && (p.active !== false || admin);
      })
      .sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
  }

  // Categoria sem nenhum produto à mostra vira um chip que não leva a lugar
  // nenhum — então ela simplesmente não aparece.
  function categoriasComProduto(secao, produtos) {
    var cats = (PL.catalogo.categorias || [])
      .filter(function (c) {
        if (c.section_id !== secao.id || c.active === false) return false;
        return produtos.some(function (p) { return p.category_id === c.id; });
      })
      .sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });

    // Produto cadastrado sem categoria (ou com a categoria apagada depois)
    // ganha um grupo próprio no fim, para não desaparecer do cardápio.
    var soltos = produtos.some(function (p) {
      return !p.category_id || !cats.some(function (c) { return c.id === p.category_id; });
    });
    if (soltos) cats.push({ id: SEM_CATEGORIA, name: "Outros" });
    return cats;
  }

  function produtosDaCategoria(produtos, cats, catId) {
    if (catId === SEM_CATEGORIA) {
      return produtos.filter(function (p) {
        return !p.category_id || !cats.some(function (c) { return c.id === p.category_id; });
      });
    }
    return produtos.filter(function (p) { return p.category_id === catId; });
  }

  function produtoPorId(id) {
    return (PL.catalogo.produtos || []).filter(function (p) { return p.id === id; })[0] || null;
  }

  function quiosquesAtivos() {
    return (PL.catalogo.quiosques || [])
      .filter(function (q) { return q.active !== false; })
      .sort(function (a, b) { return (a.number || 0) - (b.number || 0); });
  }

  // ==================================================================
  //  CARRINHO
  //  Vive na memória E no localStorage. O tablet pode recarregar no meio
  //  de um pedido grande (atualização do app, tela travada, criança
  //  mexendo) — e refazer 12 itens na mão ninguém merece.
  // ==================================================================
  function lerCarrinhoGravado() {
    try {
      var bruto = JSON.parse(localStorage.getItem(CHAVE_CARRINHO) || "[]");
      if (!Array.isArray(bruto)) return [];
      return bruto
        .filter(function (l) { return l && l.product_id; })
        .map(function (l) {
          return {
            product_id: String(l.product_id),
            qty: Math.max(1, Number(l.qty) || 1),
            notes: typeof l.notes === "string" ? l.notes : "",
          };
        });
    } catch (e) {
      return [];
    }
  }

  function gravarCarrinho() {
    try { localStorage.setItem(CHAVE_CARRINHO, JSON.stringify(carrinho)); } catch (e) { /* tablet com armazenamento cheio: o pedido continua na memória */ }
  }

  // Produto apagado, desligado ou esgotado depois que entrou no carrinho: sai
  // fora. O banco recusaria o pedido inteiro por causa dele (o place_order só
  // aceita produto active + available), e o quiosque ficaria sem entender.
  function limparCarrinhoFantasma() {
    var antes = carrinho.length;
    carrinho = carrinho.filter(function (l) {
      var p = produtoPorId(l.product_id);
      return p && p.active !== false && p.available !== false;
    });
    if (carrinho.length !== antes) {
      gravarCarrinho();
      PL.aviso("Tirei do pedido um item que saiu do cardápio.", "avisa");
    }
  }

  function itemDoCarrinho(id) {
    return carrinho.filter(function (l) { return l.product_id === id; })[0] || null;
  }

  function qtdNoCarrinho(id) {
    var l = itemDoCarrinho(id);
    return l ? l.qty : 0;
  }

  // Soma sempre, mesmo com PL.CFG.mostrarPreco desligado: quem esconde o
  // preço na tela do quiosque ainda quer o total certo no banco.
  function resumoCarrinho() {
    var qtd = 0, centavos = 0;
    carrinho.forEach(function (l) {
      var p = produtoPorId(l.product_id);
      if (!p) return;
      qtd += l.qty;
      centavos += (p.price_cents || 0) * l.qty;
    });
    return { qtd: qtd, centavos: centavos };
  }

  function adicionarAoCarrinho(id) {
    var p = produtoPorId(id);
    if (!p) return;

    // Esgotado é o "acabou hoje" que a recepção liga. O cartão fica na tela
    // (para o quiosque saber que o item existe) mas não entra no pedido.
    if (p.available === false) {
      PL.aviso(p.name + " está esgotado hoje.", "avisa");
      return;
    }
    // Item oculto só aparece para o admin conferir o cadastro. O banco recusa
    // pedido de produto desligado, então nem deixamos chegar lá.
    if (p.active === false) {
      PL.aviso("Este item está oculto do cardápio e não pode ser pedido.", "avisa");
      return;
    }

    var linha = itemDoCarrinho(id);
    if (linha) linha.qty += 1;
    else carrinho.push({ product_id: id, qty: 1, notes: "" });

    gravarCarrinho();
    PL.vibrar([25]);           // resposta no dedo: dá para pedir sem olhar a tela
    atualizarCartao(id);
    desenharBarraCarrinho();
  }

  function mudarQtd(id, passo) {
    var linha = itemDoCarrinho(id);
    if (!linha) return;
    linha.qty += passo;
    // chegou a zero = o quiosque quis tirar o item; não faz sentido guardar
    if (linha.qty < 1) carrinho = carrinho.filter(function (l) { return l !== linha; });
    gravarCarrinho();
  }

  function esvaziarCarrinho() {
    carrinho = [];
    observacaoGeral = "";
    nomeCliente = "";
    lugarPedido = "";
    gravarCarrinho();
  }

  // ==================================================================
  //  POR QUAL QUIOSQUE O PEDIDO VAI
  // ==================================================================
  function quiosqueDoPedido() {
    // Quem tem quiosque no perfil sempre pede por ele: o RPC place_order
    // ignora qualquer outra escolha quando o papel é 'quiosque'.
    if (PL.ctx.quiosque) return PL.ctx.quiosque.id;
    // O admin não tem quiosque, então precisa dizer por quem está lançando.
    var ativos = quiosquesAtivos();
    if (quiosqueEscolhido && ativos.some(function (q) { return q.id === quiosqueEscolhido; })) {
      return quiosqueEscolhido;
    }
    return null;
  }

  function lerQuiosqueGravado() {
    // Veio pelo QR do quiosque 7? Então é por ele que este aparelho lança,
    // mesmo que tenha ficado outro escolhido da última vez. O QR é uma
    // decisão explícita de quem escaneou; o guardado é só a última memória.
    var doLink = PL.quiosqueDoLink;
    if (doLink) {
      var achado = quiosquesAtivos().filter(function (q) { return Number(q.number) === doLink; })[0];
      if (achado) return achado.id;
    }
    try { return localStorage.getItem(CHAVE_QUIOSQUE) || null; } catch (e) { return null; }
  }

  // ==================================================================
  //  TELA 1 — CARDÁPIO
  // ==================================================================
  function montarCardapio(alvo) {
    telaCardapioAtiva = true;
    carrinho = lerCarrinhoGravado();
    quiosqueEscolhido = lerQuiosqueGravado();

    try { abaAtual = localStorage.getItem(CHAVE_ABA) || abaAtual; } catch (e) { /* sem localStorage: começa na primeira aba */ }

    areaTopo = document.createElement("div");
    areaAbas = document.createElement("div");
    areaAbas.className = "abas";
    areaSecao = document.createElement("div");

    alvo.appendChild(areaTopo);
    alvo.appendChild(areaAbas);
    alvo.appendChild(areaSecao);

    // O catálogo pode ter mudado enquanto a tela estava fechada.
    limparCarrinhoFantasma();

    desenharTopo();
    desenharAbas();
    desenharSecao();
    desenharBarraCarrinho();
  }

  // ---- seletor de quiosque (só para o admin, que não tem um) ----
  function desenharTopo() {
    if (!areaTopo) return;
    // Escondido de verdade (e não só vazio): a área de conteúdo é uma coluna com
    // espaço entre os filhos, e uma caixa vazia deixaria um buraco no topo.
    if (PL.ctx.quiosque) { areaTopo.innerHTML = ""; areaTopo.hidden = true; return; }
    areaTopo.hidden = false;

    var ativos = quiosquesAtivos();
    if (!ativos.length) {
      areaTopo.innerHTML =
        '<div class="aviso aviso-warn">Nenhum quiosque cadastrado ainda. Abra o 🛠️ e cadastre os quiosques antes de lançar pedidos.</div>';
      return;
    }

    areaTopo.innerHTML =
      '<div class="card" style="padding:14px">' +
        '<label class="field">' +
          "<span>Você está lançando o pedido por qual quiosque?</span>" +
          '<select id="selQuiosque">' +
            '<option value="">— escolha o quiosque —</option>' +
            ativos.map(function (q) {
              return '<option value="' + PL.esc(q.id) + '"' +
                (q.id === quiosqueEscolhido ? " selected" : "") + ">" +
                PL.esc(q.name || ("Quiosque " + q.number)) + "</option>";
            }).join("") +
          "</select>" +
          '<span class="field-hint">Este aparelho é de administrador: sem escolher o quiosque, o banco não sabe para onde entregar.</span>' +
        "</label>" +
      "</div>";

    var sel = PL.$("#selQuiosque", areaTopo);
    sel.addEventListener("change", function () {
      quiosqueEscolhido = sel.value || null;
      try {
        if (quiosqueEscolhido) localStorage.setItem(CHAVE_QUIOSQUE, quiosqueEscolhido);
        else localStorage.removeItem(CHAVE_QUIOSQUE);
      } catch (e) { /* não é grave: vale só nesta sessão */ }
      desenharBarraCarrinho();
    });
  }

  // ---- faixa de abas (uma por seção cadastrada) ----
  function desenharAbas() {
    if (!areaAbas) return;
    var lista = secoesVisiveis();
    // sem nenhuma aba cadastrada a faixa some inteira, em vez de ficar uma
    // tira em branco por cima do recado de "o cardápio ainda não foi montado"
    if (!lista.length) { areaAbas.innerHTML = ""; areaAbas.hidden = true; return; }
    areaAbas.hidden = false;

    var atual = secaoAtual();
    areaAbas.innerHTML = lista.map(function (s) {
      return '<button type="button" class="aba' + (s.id === atual.id ? " is-active" : "") +
        '" data-secao="' + PL.esc(s.id) + '">' +
        (s.icon ? '<span class="aba-icone">' + PL.esc(s.icon) + "</span>" : "") +
        "<span>" + PL.esc(s.label) + "</span></button>";
    }).join("");

    areaAbas.onclick = function (e) {
      var b = e.target.closest("[data-secao]");
      if (!b) return;
      abaAtual = b.getAttribute("data-secao");
      try { localStorage.setItem(CHAVE_ABA, abaAtual); } catch (e2) { /* volta na primeira aba depois de recarregar */ }
      desenharAbas();
      desenharSecao();
    };

    // Com muitas abas a escolhida pode nascer fora da tela; trazemos ela
    // para o meio da faixa para o quiosque saber onde está.
    try {
      var ativa = PL.$(".aba.is-active", areaAbas);
      if (ativa && ativa.scrollIntoView) ativa.scrollIntoView({ inline: "center", block: "nearest" });
    } catch (e) { /* navegador antigo: a faixa fica onde estiver */ }
  }

  // ---- conteúdo da aba escolhida ----
  function desenharSecao() {
    if (!areaSecao) return;
    var secao = secaoAtual();

    if (!secao) {
      areaSecao.innerHTML =
        '<div class="vazio"><b>O cardápio ainda não foi montado</b>' +
        "Nenhuma aba foi criada até agora. Entre com o usuário de administrador e use o botão 🛠️ " +
        "para criar as abas (Comida, Pesca, Dicas…), as categorias e os produtos.</div>";
      areaSecao.onclick = null;
      return;
    }

    if (secao.kind === "tips") desenharDicas(secao);
    else desenharProdutos(secao);
  }

  // ---- aba de produtos ----
  function desenharProdutos(secao) {
    var produtos = produtosDaSecao(secao);
    if (!produtos.length) {
      areaSecao.innerHTML =
        '<div class="vazio"><b>' + PL.esc(secao.label) + " ainda está vazio</b>" +
        "Nenhum produto cadastrado nesta aba. O administrador cadastra pelo ⚙️ aqui de cima.</div>";
      areaSecao.onclick = null;
      return;
    }

    var cats = categoriasComProduto(secao, produtos);
    var escolhida = categoriaPorSecao[secao.id] || "";
    // categoria apagada enquanto a tela estava aberta volta para "Tudo"
    if (escolhida && !cats.some(function (c) { return c.id === escolhida; })) escolhida = "";

    var html = "";

    // Com uma categoria só, os chips não ajudam ninguém — viram enfeite.
    if (cats.length > 1) {
      html += '<div class="chips">' +
        '<button type="button" class="chip' + (escolhida ? "" : " is-active") + '" data-cat="">Tudo</button>' +
        cats.map(function (c) {
          return '<button type="button" class="chip' + (escolhida === c.id ? " is-active" : "") +
            '" data-cat="' + PL.esc(c.id) + '">' + PL.esc(c.name) + "</button>";
        }).join("") +
        "</div>";
    }

    if (escolhida) {
      html += grade(produtosDaCategoria(produtos, cats, escolhida), secao);
    } else if (cats.length > 1) {
      // "Tudo" mostra tudo, mas separado por categoria: numa lista corrida de
      // 40 itens ninguém acha a bebida.
      cats.forEach(function (c) {
        var doGrupo = produtosDaCategoria(produtos, cats, c.id);
        if (!doGrupo.length) return;
        html += '<h2 class="grupo-tit">' + PL.esc(c.name) + "</h2>" + grade(doGrupo, secao);
      });
    } else {
      html += grade(produtos, secao);
    }

    areaSecao.innerHTML = html;

    areaSecao.onclick = function (e) {
      var chip = e.target.closest("[data-cat]");
      if (chip) {
        categoriaPorSecao[secao.id] = chip.getAttribute("data-cat");
        desenharProdutos(secao);
        return;
      }
      // O cartão inteiro adiciona, não só o "+": alvo de toque grande é o que
      // faz o pedido andar rápido num tablet, muitas vezes com a mão molhada.
      var cartao = e.target.closest("[data-prod]");
      if (cartao) adicionarAoCarrinho(cartao.getAttribute("data-prod"));
    };
  }

  function grade(produtos, secao) {
    return '<div class="produtos">' +
      produtos.map(function (p) { return cartaoProduto(p, secao); }).join("") +
      "</div>";
  }

  function cartaoProduto(p, secao) {
    var esgotado = p.available === false;
    var oculto = p.active === false;
    var qtd = qtdNoCarrinho(p.id);

    // .esgotado deixa o cartão apagado; serve igualmente para o item oculto,
    // porque nos dois casos ele está na tela só como informação.
    var classes = "produto" + (esgotado || oculto ? " esgotado" : "");

    var foto = p.image_url
      ? '<img class="produto-foto" src="' + PL.esc(p.image_url) + '" alt="" loading="lazy">'
      : '<div class="produto-sem-foto">' + PL.esc(secao.icon || "🍽️") + "</div>";

    var selo = oculto
      ? '<span class="selo-oculto">Oculto</span>'
      : (esgotado ? '<span class="selo-esgotado">Esgotado</span>' : "");

    var preco = mostraPreco()
      ? '<span><span class="produto-preco">' + PL.dinheiro(p.price_cents) + "</span> " +
        '<span class="produto-unidade">/ ' + PL.esc(p.unit || "un") + "</span></span>"
      : '<span class="produto-unidade">' + PL.esc(p.unit || "un") + "</span>";

    return '<div class="' + classes + '" data-prod="' + PL.esc(p.id) + '">' +
      foto + selo +
      (qtd ? '<span class="produto-qtd">' + qtd + "</span>" : "") +
      '<div class="produto-corpo">' +
        '<span class="produto-nome">' + PL.esc(p.name) + "</span>" +
        (p.description ? '<span class="produto-desc">' + PL.esc(p.description) + "</span>" : "") +
        '<div class="produto-rodape">' + preco +
          '<button type="button" class="produto-add" aria-label="Adicionar ' + PL.esc(p.name) + '">+</button>' +
        "</div>" +
      "</div>" +
    "</div>";
  }

  // Atualiza SÓ a bolinha da quantidade, sem redesenhar a grade inteira: o
  // navegador recarregaria as fotos e a tela piscaria a cada toque.
  function atualizarCartao(id) {
    if (!areaSecao) return;
    var cartao = PL.$('[data-prod="' + id + '"]', areaSecao);
    if (!cartao) return;
    var qtd = qtdNoCarrinho(id);
    var bolha = PL.$(".produto-qtd", cartao);
    if (qtd > 0) {
      if (!bolha) {
        bolha = document.createElement("span");
        bolha.className = "produto-qtd";
        cartao.appendChild(bolha);
      }
      bolha.textContent = qtd;
    } else if (bolha) {
      bolha.remove();
    }
  }

  function atualizarTodosCartoes() {
    if (!areaSecao) return;
    PL.$$("[data-prod]", areaSecao).forEach(function (c) {
      atualizarCartao(c.getAttribute("data-prod"));
    });
  }

  // ---- aba de dicas ----
  function desenharDicas(secao) {
    var meuQuiosque = PL.ctx.perfil ? PL.ctx.perfil.kiosk_id : null;

    var lista = (PL.catalogo.dicas || [])
      .filter(function (d) {
        if (d.section_id !== secao.id || d.active === false) return false;
        // dica sem quiosque vale para todo mundo; com quiosque, só para ele.
        // (o admin não tem kiosk_id, então enxerga só as gerais)
        return !d.kiosk_id || d.kiosk_id === meuQuiosque;
      })
      .sort(function (a, b) {
        if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;  // fixadas na frente
        return (a.sort_order || 0) - (b.sort_order || 0);
      });

    if (!lista.length) {
      areaSecao.innerHTML =
        '<div class="vazio"><b>' + PL.esc(secao.label) + " ainda está vazio</b>" +
        "Nenhuma dica cadastrada nesta aba. O administrador escreve as dicas pelo ⚙️ aqui de cima.</div>";
      return;
    }

    areaSecao.innerHTML = '<div class="dicas">' + lista.map(function (d) {
      return '<article class="dica' + (d.pinned ? " fixa" : "") + '">' +
        (d.image_url ? '<img class="dica-foto" src="' + PL.esc(d.image_url) + '" alt="" loading="lazy">' : "") +
        "<h3>" + PL.esc(d.title) +
          (d.pinned ? ' <span class="dica-selo">Fixado</span>' : "") +
        "</h3>" +
        (d.body ? "<p>" + PL.esc(d.body) + "</p>" : "") +
      "</article>";
    }).join("") + "</div>";

    areaSecao.onclick = null;
  }

  // ==================================================================
  //  BARRA DO CARRINHO (fica grudada no rodapé)
  //  Mora no #rodapeFixo porque o núcleo limpa esse espaço a cada troca
  //  de tela — assim a barra nunca sobra por cima da tela da recepção.
  // ==================================================================
  function desenharBarraCarrinho() {
    var pe = PL.$("#rodapeFixo");
    if (!pe) return;
    // O #rodapeFixo é o mesmo para todas as telas. Limpar só o innerHTML deixaria
    // o clique do carrinho armado por baixo do que a próxima tela desenhar ali.
    if (!telaCardapioAtiva) { pe.innerHTML = ""; pe.onclick = null; return; }

    var r = resumoCarrinho();
    if (!r.qtd) { pe.innerHTML = ""; pe.onclick = null; return; }   // carrinho vazio: barra some

    var itens = r.qtd + (r.qtd === 1 ? " item" : " itens");
    var faltaQuiosque = !quiosqueDoPedido();

    pe.innerHTML =
      '<div class="carrinho-barra">' +
        '<div class="carrinho-resumo">' +
          (mostraPreco()
            ? '<span class="carrinho-qtd">' + itens + (faltaQuiosque ? " · escolha o quiosque" : "") + "</span>" +
              '<span class="carrinho-total">' + PL.dinheiro(r.centavos) + "</span>"
            : '<span class="carrinho-qtd">Seu pedido' + (faltaQuiosque ? " · escolha o quiosque" : "") + "</span>" +
              '<span class="carrinho-total">' + itens + "</span>") +
        "</div>" +
        '<div class="carrinho-acoes">' +
          '<button type="button" class="btn btn-ghost" data-acao="esvaziar" ' +
            'aria-label="Esvaziar o pedido" style="min-height:48px">🗑</button>' +
          '<button type="button" class="btn btn-accent" data-acao="ver" ' +
            'style="min-height:48px">Ver pedido</button>' +
        "</div>" +
      "</div>";

    pe.onclick = function (e) {
      var b = e.target.closest("[data-acao]");
      if (!b) return;
      if (b.getAttribute("data-acao") === "ver") abrirCarrinho();
      else perguntarSeEsvazia();
    };
  }

  function perguntarSeEsvazia() {
    PL.confirmar({
      titulo: "Esvaziar o pedido",
      texto: "Isso apaga todos os itens que você já escolheu. Quer mesmo começar de novo?",
      ok: "Esvaziar", cancelar: "Voltar", perigo: true,
    }).then(function (certeza) {
      if (!certeza) return;
      esvaziarCarrinho();
      atualizarTodosCartoes();
      desenharBarraCarrinho();
      PL.aviso("Pedido esvaziado.", "ok");
    });
  }

  // ==================================================================
  //  POP-UP DO CARRINHO
  // ==================================================================
  function abrirCarrinho() {
    limparCarrinhoFantasma();
    if (!carrinho.length) {
      desenharBarraCarrinho();
      atualizarTodosCartoes();
      PL.aviso("Seu pedido está vazio.", "avisa");
      return;
    }

    var corpo = document.createElement("div");
    corpo.style.cssText = "display:flex;flex-direction:column;gap:14px";

    var lista = document.createElement("div");
    lista.className = "carrinho-itens";

    var totalEl = document.createElement("div");
    totalEl.style.cssText =
      "display:flex;justify-content:space-between;align-items:center;" +
      "font-weight:800;font-size:1.15rem;color:var(--brand-dark)";

    var campos = document.createElement("div");
    campos.style.cssText = "display:flex;flex-direction:column;gap:12px";

    corpo.appendChild(lista);
    if (mostraPreco()) corpo.appendChild(totalEl);
    corpo.appendChild(campos);

    var pop = PL.modal({
      titulo: "Conferir o pedido",
      corpo: corpo,
      botoes: [
        { texto: "Continuar pedindo", classe: "btn-neutral" },
        {
          texto: "Enviar pedido", classe: "btn-primary", id: "btnEnviarPedido",
          acao: function (fechar) { enviarPedido(fechar); },
        },
      ],
      // Ao fechar, a tela de trás precisa refletir o que mudou aqui dentro.
      aoFechar: function () {
        atualizarTodosCartoes();
        desenharBarraCarrinho();
      },
    });

    // ---- itens (redesenhados a cada + / −) ----
    function redesenharLista() {
      if (!carrinho.length) { pop.fechar(); return; }   // tirou tudo: não há o que conferir

      lista.innerHTML = carrinho.map(function (l) {
        var p = produtoPorId(l.product_id);
        if (!p) return "";
        var linhaTotal = (p.price_cents || 0) * l.qty;
        return '<div class="ci" style="flex-wrap:wrap">' +
          '<div class="ci-info">' +
            '<span class="ci-nome">' + PL.esc(p.name) + "</span>" +
            (mostraPreco()
              ? '<span class="ci-preco">' + PL.dinheiro(p.price_cents) + " · " + PL.esc(p.unit || "un") + "</span>"
              : '<span class="ci-preco">' + PL.esc(p.unit || "un") + "</span>") +
            (PL.CFG.obsPorItem
              ? '<input class="ci-obs" type="text" maxlength="120" data-obs="' + PL.esc(l.product_id) +
                '" placeholder="Observação (ex.: sem cebola)" value="' + PL.esc(l.notes || "") + '">'
              : "") +
          "</div>" +
          '<div class="stepper">' +
            '<button type="button" data-passo="-" data-item="' + PL.esc(l.product_id) + '" aria-label="Tirar um">−</button>' +
            "<span>" + l.qty + "</span>" +
            '<button type="button" data-passo="+" data-item="' + PL.esc(l.product_id) + '" aria-label="Pôr mais um">+</button>' +
          "</div>" +
          (mostraPreco() ? '<span class="ci-total">' + PL.dinheiro(linhaTotal) + "</span>" : "") +
        "</div>";
      }).join("");

      var r = resumoCarrinho();
      totalEl.innerHTML = "<span>Total</span><span>" + PL.dinheiro(r.centavos) + "</span>";
    }

    lista.addEventListener("click", function (e) {
      var b = e.target.closest("[data-passo]");
      if (!b) return;
      mudarQtd(b.getAttribute("data-item"), b.getAttribute("data-passo") === "+" ? 1 : -1);
      redesenharLista();
      desenharBarraCarrinho();
      atualizarTodosCartoes();
    });

    // A observação é guardada a cada tecla: se a lista for redesenhada (ou o
    // tablet recarregar), o que já foi escrito continua lá.
    lista.addEventListener("input", function (e) {
      var campo = e.target.closest("[data-obs]");
      if (!campo) return;
      var l = itemDoCarrinho(campo.getAttribute("data-obs"));
      if (!l) return;
      l.notes = campo.value;
      gravarCarrinho();
    });

    // ---- campos do fim (desenhados uma vez só, para não perder o foco) ----
    var htmlCampos = "";
    if (!quiosqueDoPedido()) {
      htmlCampos +=
        '<div class="aviso aviso-warn">Escolha lá em cima por qual quiosque este pedido vai antes de enviar.</div>';
    }
    htmlCampos +=
      '<label class="field"><span>Observação do pedido</span>' +
      '<textarea id="campoObs" rows="2" maxlength="300" ' +
      'placeholder="Ex.: entregar tudo junto, sem pressa"></textarea></label>';

    if (PL.CFG.pedirNomeCliente) {
      htmlCampos +=
        '<label class="field"><span>Nome de quem está pedindo</span>' +
        '<input id="campoNome" type="text" maxlength="60" placeholder="Ex.: Seu Antônio"></label>';
    }
    if (PL.CFG.pedirLugar) {
      htmlCampos +=
        '<label class="field"><span>' + PL.esc(PL.CFG.rotuloLugar || "Lugar") + "</span>" +
        '<input id="campoLugar" type="text" maxlength="40" placeholder="Ex.: guarda-sol 4"></label>';
    }
    campos.innerHTML = htmlCampos;

    // Os valores entram por .value (e não dentro do HTML) para não haver
    // chance de um texto do usuário quebrar a montagem da tela.
    var cObs = PL.$("#campoObs", campos);
    var cNome = PL.$("#campoNome", campos);
    var cLugar = PL.$("#campoLugar", campos);
    if (cObs) { cObs.value = observacaoGeral; cObs.addEventListener("input", function () { observacaoGeral = cObs.value; }); }
    if (cNome) { cNome.value = nomeCliente; cNome.addEventListener("input", function () { nomeCliente = cNome.value; }); }
    if (cLugar) { cLugar.value = lugarPedido; cLugar.addEventListener("input", function () { lugarPedido = cLugar.value; }); }

    redesenharLista();

    // Sem quiosque escolhido o envio nem começa: o erro viria do banco, em
    // inglês, depois de o quiosque achar que o pedido tinha ido.
    var btn = PL.$("#btnEnviarPedido");
    if (btn && !quiosqueDoPedido()) btn.disabled = true;
  }

  // ==================================================================
  //  ENVIAR O PEDIDO
  // ==================================================================
  function enviarPedido(fecharModal) {
    if (enviando) return;   // dois toques rápidos no tablet dariam dois pedidos

    var quiosqueId = quiosqueDoPedido();
    if (!quiosqueId) {
      PL.aviso("Escolha o quiosque antes de enviar o pedido.", "erro");
      return;
    }
    if (!carrinho.length) {
      PL.aviso("Seu pedido está vazio.", "avisa");
      return;
    }

    var itens = carrinho.map(function (l) {
      return {
        product_id: l.product_id,
        qty: l.qty,
        notes: (l.notes || "").trim() || null,
      };
    });

    var r = resumoCarrinho();
    var texto = "Vou mandar <b>" + r.qtd + (r.qtd === 1 ? " item" : " itens") + "</b> para a recepção" +
      (mostraPreco() ? ", no total de <b>" + PL.esc(PL.dinheiro(r.centavos)) + "</b>" : "") + ".";

    // A trava liga JÁ no primeiro toque, e não só na hora de falar com o banco:
    // sem isso, dois toques rápidos no tablet abririam duas telas de confirmação
    // empilhadas — e quem confirmasse as duas mandaria o mesmo pedido duas vezes.
    enviando = true;
    var botaoEnviar = PL.$("#btnEnviarPedido");
    if (botaoEnviar) botaoEnviar.disabled = true;

    var seguir = PL.CFG.confirmarEnvio
      ? PL.confirmar({ titulo: "Enviar o pedido", texto: texto, ok: "Enviar", cancelar: "Conferir de novo" })
      : Promise.resolve(true);

    seguir.then(function (certeza) {
      if (!certeza) {
        // desistiu: o botão precisa voltar ao normal, senão o quiosque fica com
        // um "Enviar pedido" morto e teria que recarregar o tablet
        enviando = false;
        if (botaoEnviar) botaoEnviar.disabled = false;
        return;
      }
      mandar(itens, quiosqueId, fecharModal);
    });
  }

  async function mandar(itens, quiosqueId, fecharModal) {
    var btn = PL.$("#btnEnviarPedido");
    enviando = true;
    if (btn) { btn.disabled = true; btn.textContent = "Enviando…"; }

    try {
      var pedido = await PL.backend.criarPedido({
        itens: itens,
        observacao: (observacaoGeral || "").trim() || null,
        cliente: (nomeCliente || "").trim() || null,
        lugar: (lugarPedido || "").trim() || null,
        quiosqueId: quiosqueId,
      });

      var numero = pedido && pedido.daily_number ? pedido.daily_number : "";

      esvaziarCarrinho();
      atualizarTodosCartoes();
      desenharBarraCarrinho();
      if (fecharModal) fecharModal();

      PL.aviso("Pedido enviado! Número " + numero, "ok");
      PL.vibrar();

      // A lista de "Meus pedidos" precisa já nascer com este pedido dentro.
      PL.recarregarPedidos().catch(function (e) { console.warn("Recarga após enviar:", e); });

      avisoDePedidoEnviado(numero);
    } catch (e) {
      console.error("Falha ao enviar o pedido", e);
      PL.aviso(PL.erroLegivel(e), "erro");
    } finally {
      // Sempre destrava, mesmo quando deu erro: senão o quiosque ficaria com
      // um botão morto e teria que recarregar o tablet.
      enviando = false;
      if (btn) { btn.disabled = false; btn.textContent = "Enviar pedido"; }
    }
  }

  // Confirmação grande e curta: no meio do movimento ninguém lê parágrafo —
  // o que interessa é o número que a recepção vai chamar.
  function avisoDePedidoEnviado(numero) {
    var botoes = [{ texto: "Continuar", classe: "btn-primary" }];
    if (PL.ehQuiosque() && PL.CFG.mostrarMeusPedidos !== false) {
      botoes.unshift({
        texto: "Acompanhar", classe: "btn-neutral",
        acao: function (fechar) { fechar(); PL.irPara("meuspedidos"); },
      });
    }
    PL.modal({
      titulo: "Pedido enviado",
      corpo:
        '<div style="text-align:center;padding:8px 0">' +
          '<div style="font-size:2.6rem">✅</div>' +
          '<div style="font-size:2.4rem;font-weight:800;color:var(--brand-dark);line-height:1.1">#' +
            PL.esc(numero) + "</div>" +
          '<p style="margin:8px 0 0;color:var(--muted);line-height:1.5">' +
            "A recepção já recebeu. Quando estiver pronto, alguém leva até o quiosque.</p>" +
        "</div>",
      botoes: botoes,
    });
  }

  // ==================================================================
  //  TELA 2 — MEUS PEDIDOS
  // ==================================================================
  function montarMeusPedidos(alvo) {
    telaPedidosAtiva = true;
    assinaturaPedidos = null;
    caixaPedidos = document.createElement("div");
    caixaPedidos.style.cssText = "display:flex;flex-direction:column;gap:14px";
    alvo.appendChild(caixaPedidos);

    caixaPedidos.addEventListener("click", function (e) {
      var b = e.target.closest("[data-cancelar]");
      if (!b) return;
      var p = meusPedidos().filter(function (x) { return x.id === b.getAttribute("data-cancelar"); })[0];
      if (p) pedirCancelamento(p);
    });

    desenharMeusPedidos();
  }

  // A RLS do banco já entrega só os pedidos deste quiosque. Para o ADMIN,
  // que enxerga tudo, valem os pedidos do quiosque que ele escolheu lá no
  // cardápio — senão esta tela viraria uma cópia do quadro da recepção.
  function meusPedidos() {
    var meu = (PL.ctx.perfil && PL.ctx.perfil.kiosk_id) || quiosqueDoPedido();
    var lista = (PL.pedidos || []).filter(function (p) {
      return !meu || p.kiosk_id === meu;
    });

    // Abertos primeiro (é o que o quiosque está esperando), e dentro de cada
    // grupo o mais novo em cima.
    return lista.sort(function (a, b) {
      var aa = PL.ABERTOS.indexOf(a.status) >= 0 ? 0 : 1;
      var bb = PL.ABERTOS.indexOf(b.status) >= 0 ? 0 : 1;
      if (aa !== bb) return aa - bb;
      return new Date(b.created_at) - new Date(a.created_at);
    });
  }

  // Só redesenhamos quando alguma coisa mudou de verdade: a recarga de
  // segurança do núcleo bate a cada 45 s e faria os cartões piscarem
  // (a animação de "pedido novo") sem motivo nenhum.
  function assinatura(lista) {
    return lista.map(function (p) {
      return p.id + ":" + p.status + ":" + p.updated_at;
    }).join("|");
  }

  function desenharMeusPedidos(forcar) {
    if (!caixaPedidos) return;
    var lista = meusPedidos();
    var nova = assinatura(lista);
    if (!forcar && nova === assinaturaPedidos) { atualizarRelogios(); return; }
    assinaturaPedidos = nova;

    if (!lista.length) {
      caixaPedidos.innerHTML =
        '<div class="vazio"><b>Nenhum pedido hoje</b>' +
        "Abra a aba <b>Cardápio</b>, escolha o que o cliente quer e toque em <b>Ver pedido</b>.</div>";
      return;
    }

    var abertos = lista.filter(function (p) { return PL.ABERTOS.indexOf(p.status) >= 0; });

    caixaPedidos.innerHTML =
      '<div class="card" style="padding:14px">' +
        '<div class="card-head" style="margin:0">' +
          '<h2 class="card-title">📋 Meus pedidos de hoje</h2>' +
          '<span class="hint">' + lista.length + (lista.length === 1 ? " pedido" : " pedidos") +
            " · " + abertos.length + " em andamento</span>" +
        "</div>" +
      "</div>" +
      '<div style="display:grid;gap:12px;align-items:start;' +
        'grid-template-columns:repeat(auto-fill,minmax(290px,1fr))">' +
        lista.map(cartaoPedido).join("") +
      "</div>";
  }

  function cartaoPedido(p) {
    var aberto = PL.ABERTOS.indexOf(p.status) >= 0;
    var min = PL.minutosDesde(p.created_at);
    var st = PL.STATUS[p.status] || { rotulo: p.status, icone: "" };
    var itens = p.itens || [];   // o banco pode devolver o pedido sem os itens
    // items_count vem do banco; passa por Number para nunca virar texto solto
    // dentro do HTML (e porque o pedido pode chegar antes de a conta fechar).
    var qtdItens = Number(p.items_count || itens.length) || 0;

    var tempo = aberto
      ? '<span class="pedido-tempo ' + classeTempo(min) + '" data-criado="' + PL.esc(p.created_at) + '">' +
        PL.tempoCurto(min) + "</span>"
      : '<span class="pedido-tempo' + (p.status === "lancado" ? "" : " atrasado") + '">' +
        PL.hora(p.launched_at || p.updated_at || p.created_at) + "</span>";

    var metas =
      '<span class="status-chip status-' + PL.esc(p.status) + '">' + PL.esc(st.rotulo) + "</span>" +
      (p.table_label ? '<span class="meta">📍 ' + PL.esc(p.table_label) + "</span>" : "") +
      (p.customer_name ? '<span class="meta">🙋 ' + PL.esc(p.customer_name) + "</span>" : "") +
      (p.notes ? '<span class="meta obs">📝 ' + PL.esc(p.notes) + "</span>" : "") +
      (p.error_reason ? '<span class="meta erro">⚠ ' + PL.esc(p.error_reason) + "</span>" : "");

    var acoes = p.status === "recebido"
      ? '<button type="button" class="btn btn-danger btn-sm" data-cancelar="' + PL.esc(p.id) + '">Cancelar</button>'
      : '<span class="hint">' + PL.esc(st.icone + " " + st.rotulo) + "</span>";

    return '<article class="pedido' + (aberto && min >= atrasadoEm() ? " atrasado" : "") +
      '" data-status="' + PL.esc(p.status) + '">' +
      '<div class="pedido-topo">' +
        '<div class="pedido-quiosque">' +
          "<b>Pedido #" + PL.esc(p.daily_number) + "</b>" +
          '<span class="pedido-num">' + PL.hora(p.created_at) + " · " +
            qtdItens + (qtdItens === 1 ? " item" : " itens") +
          "</span>" +
        "</div>" + tempo +
      "</div>" +
      '<div class="pedido-itens">' +
        (itens.length
          ? itens.map(function (i) {
              return '<div class="pi">' +
                '<span class="pi-qtd">' + PL.esc(i.qty) + "×</span>" +
                '<span class="pi-nome">' + PL.esc(i.product_name) +
                  (i.notes ? '<span class="pi-obs">' + PL.esc(i.notes) + "</span>" : "") +
                "</span>" +
                (mostraPreco() ? '<span class="pi-valor">' + PL.dinheiro(i.line_total_cents) + "</span>" : "") +
              "</div>";
            }).join("")
          : '<span class="hint">Itens a caminho…</span>') +
      "</div>" +
      '<div class="pedido-meta">' + metas + "</div>" +
      '<div class="pedido-rodape">' +
        (mostraPreco() ? '<span class="pedido-total">' + PL.dinheiro(p.total_cents) + "</span>" : "<span></span>") +
        '<div class="pedido-acoes">' + acoes + "</div>" +
      "</div>" +
    "</article>";
  }

  // ---- semáforo do tempo de espera ----
  // O que vale é o que o admin ajustou na nuvem; o config.js é só o padrão
  // de fábrica, para o app funcionar antes de alguém configurar qualquer coisa.
  function atencaoEm() {
    var c = PL.ctx.cliente || {};
    return Number(c.sla_warn_minutes) || Number(PL.CFG.slaAtencao) || 5;
  }
  function atrasadoEm() {
    var c = PL.ctx.cliente || {};
    return Number(c.sla_late_minutes) || Number(PL.CFG.slaAtrasado) || 12;
  }
  function classeTempo(min) {
    if (min >= atrasadoEm()) return "atrasado";
    if (min >= atencaoEm()) return "atencao";
    return "";
  }

  // O relógio anda mesmo sem nada mudar no banco. Mexemos só no texto e na
  // cor: redesenhar os cartões a cada 20 s reiniciaria a animação de todos.
  function atualizarRelogios() {
    if (!caixaPedidos) return;
    PL.$$("[data-criado]", caixaPedidos).forEach(function (el) {
      var min = PL.minutosDesde(el.getAttribute("data-criado"));
      el.textContent = PL.tempoCurto(min);
      el.className = "pedido-tempo " + classeTempo(min);
      var cartao = el.closest(".pedido");
      if (cartao) cartao.classList.toggle("atrasado", min >= atrasadoEm());
    });
  }

  // ==================================================================
  //  CANCELAR (a única ação de status que o quiosque tem)
  //  O banco só aceita cancelamento enquanto o pedido está em 'recebido' —
  //  depois disso a comida já está sendo feita, e quem decide é a recepção.
  // ==================================================================
  function pedirCancelamento(p) {
    // Dois toques no mesmo botão abririam dois pop-ups iguais, um por cima do
    // outro — e o de baixo continuaria falando de um pedido que já mudou.
    if (cancelandoPedido) return;
    cancelandoPedido = p.id;

    var motivo = "";

    var corpo = document.createElement("div");
    corpo.style.cssText = "display:flex;flex-direction:column;gap:14px";
    corpo.innerHTML =
      '<p style="margin:0;line-height:1.55">Você está cancelando o <b>pedido #' + PL.esc(p.daily_number) +
        "</b>, feito às " + PL.hora(p.created_at) + ". Isso não tem volta — para pedir de novo é preciso montar o pedido outra vez.</p>" +
      '<div class="motivos">' +
        MOTIVOS_CANCELAR.map(function (m) {
          return '<button type="button" class="motivo" data-motivo="' + PL.esc(m) + '">' + PL.esc(m) + "</button>";
        }).join("") +
      "</div>" +
      '<label class="field"><span>Motivo</span>' +
        '<input id="campoMotivo" type="text" maxlength="80" placeholder="Escreva o motivo em poucas palavras"></label>';

    var campo = PL.$("#campoMotivo", corpo);

    corpo.addEventListener("click", function (e) {
      var b = e.target.closest("[data-motivo]");
      if (!b) return;
      motivo = b.getAttribute("data-motivo");
      campo.value = motivo;
      PL.$$(".motivo", corpo).forEach(function (x) { x.classList.toggle("is-sel", x === b); });
    });
    campo.addEventListener("input", function () {
      motivo = campo.value;
      PL.$$(".motivo", corpo).forEach(function (x) { x.classList.remove("is-sel"); });
    });

    PL.modal({
      titulo: "Cancelar o pedido #" + p.daily_number,
      corpo: corpo,
      botoes: [
        { texto: "Voltar", classe: "btn-neutral" },
        {
          texto: "Cancelar o pedido", classe: "btn-danger", id: "btnConfirmaCancelar",
          acao: function (fechar) { cancelar(p, motivo, fechar); },
        },
      ],
      // De propósito sem focar o campo ao abrir: no tablet o teclado subiria
      // e taparia justamente os motivos prontos, que é o caminho mais rápido.
      aoFechar: function () { cancelandoPedido = null; },
    });
  }

  async function cancelar(p, motivo, fechar) {
    var texto = String(motivo || "").trim();
    // O banco exige motivo para 'cancelado'; sem ele a chamada voltaria com
    // erro em inglês e o quiosque não saberia o que fazer.
    if (!texto) {
      PL.aviso("Escreva o motivo para poder cancelar.", "erro");
      return;
    }

    var btn = PL.$("#btnConfirmaCancelar");
    if (btn) { btn.disabled = true; btn.textContent = "Cancelando…"; }

    try {
      await PL.backend.mudarStatus(p.id, "cancelado", texto);
      fechar();
      PL.aviso("Pedido #" + p.daily_number + " cancelado.", "ok");
      await PL.recarregarPedidos();
      desenharMeusPedidos(true);
    } catch (e) {
      console.error("Falha ao cancelar", e);
      // O caso mais comum: a recepção lançou o pedido entre o toque e o
      // envio, e a regra do banco (com razão) barrou o cancelamento.
      PL.aviso(PL.erroLegivel(e), "erro");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Cancelar o pedido"; }
    }
  }

  // ==================================================================
  //  OUVINTES
  //  Registrados UMA VEZ só, aqui fora. Se ficassem dentro de montar(),
  //  cada troca de aba empilharia mais um ouvinte igual — e PL.ao() não
  //  tem como desligar nenhum deles.
  // ==================================================================
  PL.ao("catalogo", function () {
    if (!telaCardapioAtiva) return;
    limparCarrinhoFantasma();
    desenharTopo();
    desenharAbas();
    desenharSecao();
    desenharBarraCarrinho();
  });

  PL.ao("pedidos", function () {
    if (!telaPedidosAtiva) return;
    desenharMeusPedidos();
  });

  PL.ao("tique", function () {
    if (!telaPedidosAtiva) return;
    atualizarRelogios();
  });

  // ==================================================================
  //  REGISTRO DAS TELAS
  // ==================================================================
  PL.registrarTela({
    id: "cardapio",
    rotulo: "Cardápio",
    icone: "🍽️",
    ordem: 10,
    papeis: ["quiosque", "admin"],
    montar: montarCardapio,
    aoSair: function () {
      // Desliga os ouvintes por interruptor e tira a barra do carrinho de
      // cima da próxima tela.
      telaCardapioAtiva = false;
      areaSecao = areaAbas = areaTopo = null;
      var pe = PL.$("#rodapeFixo");
      // o onclick vai junto: ele é do carrinho, não da tela que vem a seguir
      if (pe) { pe.innerHTML = ""; pe.onclick = null; }
    },
    // O ⚙ da barra de cima configura A ABA QUE ESTÁ ABERTA. Quem sabe fazer
    // isso é o admin.js; aqui só entregamos qual seção está na tela.
    // O ⚙ abre as configurações já na aba do cardápio, apontando para a
    // seção que está aberta atrás. Todas as outras configurações continuam
    // ali do lado, então dá para arrumar tudo sem sair e entrar de novo.
    engrenagem: function () {
      if (!window.PLAdmin || typeof window.PLAdmin.abrir !== "function") {
        PL.aviso("As configurações ainda não carregaram.", "erro");
        return;
      }
      window.PLAdmin.abrir("cardapio", secaoAtual());
    },
  });

  // A aba de acompanhamento é opcional: em casa que resolve rápido demais
  // ela só ocupa espaço na barra. Desligada no config.js, nem é registrada.
  // O admin também a enxerga — é a forma dele conferir o que o quiosque vê.
  if (PL.CFG.mostrarMeusPedidos !== false) {
    PL.registrarTela({
      id: "meuspedidos",
      rotulo: "Meus pedidos",
      icone: "📋",
      ordem: 20,
      papeis: ["quiosque", "admin"],
      montar: montarMeusPedidos,
      aoSair: function () {
        telaPedidosAtiva = false;
        caixaPedidos = null;
        assinaturaPedidos = null;
      },
    });
  }
})();
