/* ============================================================
   PEDIDOS LAGOA — RECEPÇÃO
   ============================================================
   Este arquivo desenha as DUAS telas de quem fica no balcão:

     "Pedidos"   → o quadro ao vivo. É o coração do sistema: o que
                   o quiosque pediu aparece aqui na hora, com som,
                   e a recepção empurra o cartão de coluna em coluna
                   até entregar.
     "Histórico" → a tabela do dia inteiro, com resumo e exportação
                   para o Excel (fechamento de caixa).

   Nada aqui conversa com o banco direto: tudo passa pelo núcleo
   (PL.backend). Assim o modo demonstração e o modo nuvem se
   comportam igualzinho, e esta tela não precisa saber a diferença.

   Os nomes vindos do banco ficam em inglês de propósito
   (created_at, daily_number, total_cents...) — é o mesmo nome que
   está na tabela do Supabase, então não existem dois nomes para a
   mesma coisa na hora de procurar um problema.
   ============================================================ */
(function () {
  "use strict";

  var PL = window.PL;

  // Onde ficam guardados os filtros escolhidos. Guardar no aparelho
  // (e não na nuvem) é de propósito: o tablet da recepção pode estar
  // filtrado por um quiosque sem bagunçar o tablet do administrador.
  var LS_FILTROS = "pedidos_lagoa_filtros";

  // Quanto tempo o cartão recém-chegado fica com a moldura âmbar.
  // 12 s é o suficiente para o olho encontrar o cartão novo no meio
  // dos outros sem que a tela vire uma árvore de natal.
  var MS_DESTAQUE_NOVO = 12000;

  // Espera antes de dizer ao banco "eu vi este pedido". Marcar na hora
  // seria mentira: o cartão pode ter aparecido com a recepção de costas.
  // 4 s significa que a tela ficou aberta tempo suficiente para alguém ler.
  var MS_ATE_MARCAR_VISTO = 4000;

  // ------------------------------------------------------------------
  //  ESTADO DESTE ARQUIVO
  // ------------------------------------------------------------------
  var filtros = {
    quiosque: "",        // "" = todos
    status: "abertos",   // "abertos" | "todos" | um status
    som: true,
    hQuiosque: "",       // filtros da tela de histórico
    hStatus: "todos",
  };

  var telaViva = false;        // a tela "Pedidos" está montada agora?
  var histViva = false;        // a tela "Histórico" está montada agora?
  var caixaPedidos = null;     // o #conteudo da tela de pedidos
  var caixaHist = null;        // o #conteudo da tela de histórico
  var temporizadores = [];     // tudo que precisa morrer no aoSair()
  var vistoTimer = null;
  var chegadaTimer = null;
  var novos = {};              // id do pedido -> hora em que ele apareceu
  var jaAvisados = {};         // ids já mandados para o "marcar como visto"
  var listaNaTela = [];        // o que está desenhado neste momento

  // ==================================================================
  //  FILTROS GUARDADOS
  // ==================================================================
  function lerFiltros() {
    try {
      var g = JSON.parse(localStorage.getItem(LS_FILTROS) || "{}");
      if (g && typeof g === "object") {
        filtros = Object.assign(filtros, g);
      }
    } catch (e) { /* aparelho sem localStorage: segue com o padrão */ }
    // o som só é "ligado" de verdade se o dono do sistema também deixou
    if (PL.CFG.somPedidoNovo === false) filtros.som = false;
  }

  function gravarFiltros() {
    try { localStorage.setItem(LS_FILTROS, JSON.stringify(filtros)); } catch (e) {}
  }

  // ==================================================================
  //  PEQUENAS AJUDAS
  // ==================================================================

  // O pedido traz o quiosque junto (join do banco), mas nem sempre:
  // numa conexão ruim, ou num pedido feito por outra tela, ele pode vir
  // vazio. Aí procuramos pelo kiosk_id no catálogo, e só desistimos
  // depois disso — a recepção NUNCA pode ficar sem saber de quem é.
  function quiosqueDoPedido(p) {
    if (p.quiosque && (p.quiosque.name || p.quiosque.number)) return p.quiosque;
    var lista = (PL.catalogo && PL.catalogo.quiosques) || [];
    var achado = null;
    for (var i = 0; i < lista.length; i++) {
      if (lista[i].id === p.kiosk_id) { achado = lista[i]; break; }
    }
    return achado;
  }

  function nomeDoQuiosque(p) {
    var q = quiosqueDoPedido(p);
    if (!q) return "Quiosque ?";
    return q.name || ("Quiosque " + q.number);
  }

  // O semáforo sai da configuração do cliente na nuvem; o config.js só
  // serve enquanto o administrador não ajustou nada.
  function slaAtencao() {
    var c = (PL.ctx && PL.ctx.cliente) || {};
    return Number(c.sla_warn_minutes) || Number(PL.CFG.slaAtencao) || 5;
  }
  function slaAtrasado() {
    var c = (PL.ctx && PL.ctx.cliente) || {};
    return Number(c.sla_late_minutes) || Number(PL.CFG.slaAtrasado) || 12;
  }

  function grauDoTempo(min) {
    if (min >= slaAtrasado()) return "atrasado";
    if (min >= slaAtencao()) return "atencao";
    return "";
  }

  function ehAberto(p) { return PL.ABERTOS.indexOf(p.status) >= 0; }

  function minutosEntre(inicio, fim) {
    if (!inicio || !fim) return null;
    var d = (new Date(fim).getTime() - new Date(inicio).getTime()) / 60000;
    if (isNaN(d)) return null;
    return Math.max(0, Math.round(d));
  }

  function quantosItens(p) {
    if (p.items_count) return Number(p.items_count);
    return (p.itens || []).reduce(function (s, it) { return s + (Number(it.qty) || 0); }, 0);
  }

  function totalDoItem(it) {
    if (it.line_total_cents !== null && it.line_total_cents !== undefined) return it.line_total_cents;
    return (Number(it.unit_price_cents) || 0) * (Number(it.qty) || 1);
  }

  function rotuloStatus(s) {
    return (PL.STATUS[s] && PL.STATUS[s].rotulo) || s || "?";
  }
  function iconeStatus(s) {
    return (PL.STATUS[s] && PL.STATUS[s].icone) || "";
  }

  function somLigado() {
    return PL.CFG.somPedidoNovo !== false && filtros.som !== false;
  }

  function ehNovo(p) {
    return !!novos[p.id] && (Date.now() - novos[p.id]) < MS_DESTAQUE_NOVO;
  }

  function guardarTemporizador(t) { temporizadores.push(t); return t; }

  // clearTimeout e clearInterval mexem na mesma lista do navegador, mas
  // chamar os dois deixa claro que aqui morrem relógios dos dois tipos.
  function limparTemporizadores() {
    temporizadores.forEach(function (t) { clearTimeout(t); clearInterval(t); });
    temporizadores = [];
    vistoTimer = null;
    chegadaTimer = null;
  }

  // ==================================================================
  //  O CARTÃO DO PEDIDO
  //  É o que a recepção olha o dia inteiro: quem pediu, o que pediu,
  //  há quanto tempo e o botão do próximo passo.
  // ==================================================================
  function botao(classe, texto, atributos) {
    return '<button type="button" class="btn ' + classe + '" ' + (atributos || "") + ">" +
      PL.esc(texto) + "</button>";
  }

  // Os botões seguem o caminho natural do pedido. "Voltar" existe porque
  // errar de dedo no tablet é normal — e desfazer tem que ser mais fácil
  // do que explicar para a cozinha.
  function acoesDoPedido(p, compacto) {
    var tam = compacto ? " btn-sm" : "";
    if (p.status === "recebido") {
      return botao("btn-info" + tam, "👨‍🍳 Passei p/ cozinha", 'data-ir="cozinha"') +
             botao("btn-danger" + tam, "⚠ Pediu errado", 'data-erro="1"');
    }
    if (p.status === "cozinha") {
      return botao("btn-ok" + tam, "✅ Pronto", 'data-ir="pronto"') +
             botao("btn-neutral" + tam, "↩ Voltar", 'data-ir="recebido"') +
             botao("btn-danger" + tam, "⚠ Pediu errado", 'data-erro="1"');
    }
    if (p.status === "pronto") {
      return botao("btn-primary" + tam, "📦 Entregue", 'data-ir="entregue"') +
             botao("btn-neutral" + tam, "↩ Voltar", 'data-ir="cozinha"');
    }
    // entregue / erro / cancelado: só a saída de emergência
    return botao("btn-neutral btn-sm", "↺ Reabrir", 'data-ir="recebido" data-confirmar="1"');
  }

  function linhaDoItem(it) {
    var obs = it.notes
      ? '<span class="pi-obs">↳ ' + PL.esc(it.notes) + "</span>"
      : "";
    return '<div class="pi">' +
        '<span class="pi-qtd">' + PL.esc(it.qty) + "</span>" +
        '<span class="pi-nome">' + PL.esc(it.product_name) + obs + "</span>" +
        '<span class="pi-valor">' + PL.dinheiro(totalDoItem(it)) + "</span>" +
      "</div>";
  }

  function metasDoPedido(p) {
    var partes = [];
    if (p.customer_name) partes.push('<span class="meta">👤 ' + PL.esc(p.customer_name) + "</span>");
    if (p.table_label)   partes.push('<span class="meta">📍 ' + PL.esc(p.table_label) + "</span>");
    var n = quantosItens(p);
    partes.push('<span class="meta">' + n + (n === 1 ? " item" : " itens") + "</span>");
    if (p.notes)        partes.push('<span class="meta obs">📝 ' + PL.esc(p.notes) + "</span>");
    if (p.error_reason) partes.push('<span class="meta erro">⚠ ' + PL.esc(p.error_reason) + "</span>");
    return '<div class="pedido-meta">' + partes.join("") + "</div>";
  }

  // opcoes.compacto → cartão do "Fechados hoje" (sem a lista de itens)
  // opcoes.comChip  → mostra a etiqueta do status (usado na lista única,
  //                   onde não existe a coluna para dizer em que pé está)
  function cartaoDoPedido(p, opcoes) {
    var o = opcoes || {};
    var aberto = ehAberto(p);
    var min = PL.minutosDesde(p.created_at);
    var grau = aberto ? grauDoTempo(min) : "";
    var itens = p.itens || [];

    // canto direito de cima: relógio do semáforo nos abertos, etiqueta
    // de situação nos já fechados
    var canto;
    if (aberto) {
      canto = '<span class="pedido-tempo' + (grau ? " " + grau : "") + '">' +
                PL.esc(PL.tempoCurto(min)) + "</span>";
    } else {
      // Só o pedido ENTREGUE mostra quanto demorou. Num pedido errado ou
      // cancelado esse número não quer dizer nada — e "ERRADO · agora"
      // parece que alguma coisa acabou de dar errado.
      var gasto = minutosEntre(p.created_at, p.delivered_at);
      canto = '<span class="status-chip status-' + PL.esc(p.status) + '">' +
                PL.esc((PL.STATUS[p.status] || {}).curto || p.status) +
                (gasto === null ? "" : " · " + PL.esc(PL.tempoCurto(gasto))) +
              "</span>";
    }

    var chip = (o.comChip && aberto)
      ? ' <span class="status-chip status-' + PL.esc(p.status) + '">' +
        PL.esc((PL.STATUS[p.status] || {}).curto || p.status) + "</span>"
      : "";

    var corpoItens = o.compacto
      ? ""
      : '<div class="pedido-itens">' + (itens.length
          ? itens.map(linhaDoItem).join("")
          : '<div class="hint">Este pedido chegou sem itens — confira com o quiosque.</div>') + "</div>";

    // no cartão compacto os itens ficam escondidos, então damos um jeito
    // de ver o que era sem sair da tela
    var verItens = o.compacto
      ? botao("btn-neutral btn-sm", "👁 Ver itens", 'data-detalhe="1"')
      : "";

    var classes = "pedido" +
      (ehNovo(p) ? " novo" : "") +
      (aberto && grau === "atrasado" ? " atrasado" : "");

    return '<article class="' + classes + '" data-status="' + PL.esc(p.status) + '"' +
             ' data-id="' + PL.esc(p.id) + '"' +
             (aberto ? ' data-relogio="1" data-criado="' + PL.esc(p.created_at) + '"' : "") + ">" +
        '<div class="pedido-topo">' +
          '<div class="pedido-quiosque">' +
            "<b>" + PL.esc(nomeDoQuiosque(p)) + "</b>" +
            '<span class="pedido-num">Pedido #' + PL.esc(p.daily_number) +
              " · " + PL.esc(PL.hora(p.created_at)) + chip + "</span>" +
          "</div>" +
          canto +
        "</div>" +
        corpoItens +
        metasDoPedido(p) +
        '<div class="pedido-rodape">' +
          '<span class="pedido-total">' + PL.dinheiro(p.total_cents) + "</span>" +
          '<div class="pedido-acoes">' + verItens + acoesDoPedido(p, !!o.compacto) + "</div>" +
        "</div>" +
      "</article>";
  }

  // ==================================================================
  //  TELA "PEDIDOS" — desenho
  // ==================================================================
  function opcoesDeQuiosque(escolhido) {
    var lista = ((PL.catalogo && PL.catalogo.quiosques) || [])
      .filter(function (q) { return q.active !== false; })
      .slice()
      .sort(function (a, b) { return (Number(a.number) || 0) - (Number(b.number) || 0); });

    return '<option value="">Todos os quiosques</option>' + lista.map(function (q) {
      return '<option value="' + PL.esc(q.id) + '"' +
        (q.id === escolhido ? " selected" : "") + ">" +
        PL.esc(q.name || ("Quiosque " + q.number)) + "</option>";
    }).join("");
  }

  function opcoesDeStatus(escolhido, comAbertos) {
    var html = "";
    if (comAbertos) {
      html += '<option value="abertos"' + (escolhido === "abertos" ? " selected" : "") + ">Em aberto</option>";
    }
    html += '<option value="todos"' + (escolhido === "todos" ? " selected" : "") + ">Todos</option>";
    Object.keys(PL.STATUS).forEach(function (s) {
      html += '<option value="' + PL.esc(s) + '"' + (s === escolhido ? " selected" : "") + ">" +
        iconeStatus(s) + " " + PL.esc(rotuloStatus(s)) + "</option>";
    });
    return html;
  }

  // Quais situações o filtro de cima está pedindo agora.
  function statusEscolhidos() {
    if (filtros.status === "todos") return Object.keys(PL.STATUS);
    if (filtros.status === "abertos") return PL.ABERTOS.slice();
    return [filtros.status];
  }

  function passaNoQuiosque(p) {
    return !filtros.quiosque || p.kiosk_id === filtros.quiosque;
  }

  function montarPedidos(caixa) {
    telaViva = true;
    caixaPedidos = caixa;
    lerFiltros();

    // O switch do som só aparece se o dono do sistema deixou o som ligado
    // no config. Um botão que não faz nada é pior do que botão nenhum.
    var switchSom = PL.CFG.somPedidoNovo === false ? "" :
      '<label class="switch" title="Toca um aviso quando um quiosque manda pedido">' +
        '<input type="checkbox" id="pdSom"' + (filtros.som !== false ? " checked" : "") + " />" +
        '<span class="trilho"></span>' +
        "<span>🔔 Som</span>" +
      "</label>";

    caixa.innerHTML =
      '<section class="card">' +
        '<div class="card-head">' +
          '<h1 class="card-title">🔔 Pedidos de hoje</h1>' +
          '<div class="filtros">' +
            '<select id="pdQuiosque" aria-label="Filtrar por quiosque">' +
              opcoesDeQuiosque(filtros.quiosque) + "</select>" +
            '<select id="pdStatus" aria-label="Filtrar por situação">' +
              opcoesDeStatus(filtros.status, true) + "</select>" +
            switchSom +
            '<button type="button" class="btn btn-sm btn-outline" id="pdImprimir">🖨️ Imprimir</button>' +
          "</div>" +
        "</div>" +
        '<p class="hint" id="pdResumo"></p>' +
      "</section>" +
      '<div id="pdQuadro"></div>' +
      '<section class="card" id="pdFechados" hidden></section>';

    // Um ouvinte só para a tela inteira: os cartões são redesenhados o
    // tempo todo, e um ouvinte por botão viraria lixo acumulado.
    // O núcleo esvazia o #conteudo mas reaproveita o MESMO elemento, então
    // tiramos o ouvinte antes de pôr — senão, quem entra e sai da aba três
    // vezes acaba mandando o mesmo pedido para a cozinha três vezes.
    caixa.removeEventListener("click", cliqueNaTela);
    caixa.addEventListener("click", cliqueNaTela);

    PL.$("#pdQuiosque", caixa).addEventListener("change", function () {
      filtros.quiosque = this.value;
      gravarFiltros();
      desenharPedidos();
    });
    PL.$("#pdStatus", caixa).addEventListener("change", function () {
      filtros.status = this.value;
      gravarFiltros();
      desenharPedidos();
    });
    var som = PL.$("#pdSom", caixa);
    if (som) {
      som.addEventListener("change", function () {
        filtros.som = this.checked;
        gravarFiltros();
        PL.aviso(this.checked ? "Som ligado." : "Som desligado.", "ok");
        // toca uma vez na hora de ligar: assim dá para conferir o volume
        // do tablet antes de o movimento começar
        if (this.checked) PL.tocarAviso(1);
      });
    }
    PL.$("#pdImprimir", caixa).addEventListener("click", function () { window.print(); });

    desenharPedidos();
  }

  function desenharPedidos() {
    if (!caixaPedidos) return;

    var todos = PL.pedidos || [];
    var doQuiosque = todos.filter(passaNoQuiosque);
    var escolhidos = statusEscolhidos();
    var abertosEscolhidos = escolhidos.filter(function (s) { return PL.ABERTOS.indexOf(s) >= 0; });
    var fechadosEscolhidos = escolhidos.filter(function (s) { return PL.FECHADOS.indexOf(s) >= 0; });

    var quadro = PL.$("#pdQuadro", caixaPedidos);
    var caixaFechados = PL.$("#pdFechados", caixaPedidos);
    listaNaTela = [];

    // Dia sem nenhum pedido: a tela nunca fica em branco.
    if (!todos.length) {
      quadro.innerHTML =
        '<div class="vazio">' +
          "<b>Nenhum pedido ainda hoje.</b>" +
          "Quando um quiosque pedir, ele aparece aqui na hora." +
        "</div>";
      caixaFechados.hidden = true;
      atualizarResumo();
      return;
    }

    if (abertosEscolhidos.length) {
      // ---- o quadro de trabalho: só os pedidos em andamento ----
      var emAberto = doQuiosque
        .filter(function (p) { return abertosEscolhidos.indexOf(p.status) >= 0; })
        .slice()
        // o mais antigo em cima: quem espera há mais tempo é o próximo
        .sort(function (a, b) { return new Date(a.created_at) - new Date(b.created_at); });
      listaNaTela = listaNaTela.concat(emAberto);

      if (PL.CFG.colunasStatus !== false && abertosEscolhidos.length > 1) {
        quadro.innerHTML = desenharColunas(emAberto);
      } else {
        quadro.innerHTML = desenharListaUnica(emAberto);
      }

      // ---- e embaixo, o que já foi fechado hoje ----
      // O filtro de cima manda no quadro, não aqui: escolher "Na cozinha"
      // não pode fazer o fechamento do dia sumir da vista.
      var fechados = doQuiosque
        .filter(function (p) { return !ehAberto(p); })
        .slice()
        .sort(function (a, b) { return new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at); });

      var limite = Number(PL.CFG.mostrarEntreguesHoje);
      if (!(limite > 0)) limite = 20;
      var mostrar = fechados.slice(0, limite);
      listaNaTela = listaNaTela.concat(mostrar);

      caixaFechados.hidden = false;
      caixaFechados.innerHTML =
        '<div class="card-head">' +
          '<h2 class="card-title">📦 Fechados hoje</h2>' +
          '<span class="hint">' + fechados.length +
            (fechados.length === 1 ? " pedido encerrado" : " pedidos encerrados") +
            (fechados.length > mostrar.length ? " · mostrando os " + mostrar.length + " últimos" : "") +
          "</span>" +
        "</div>" +
        (mostrar.length
          ? '<div class="coluna-lista">' +
              mostrar.map(function (p) { return cartaoDoPedido(p, { compacto: true }); }).join("") +
            "</div>"
          : '<div class="hint">Nada encerrado ainda. Assim que um pedido for entregue, ele desce para cá.</div>');
    } else {
      // O filtro pediu SÓ situações já encerradas: o quadro vira a lista
      // dessas, e o card de fechados sairia repetido — some.
      var soFechados = doQuiosque
        .filter(function (p) { return fechadosEscolhidos.indexOf(p.status) >= 0; })
        .slice()
        .sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
      listaNaTela = soFechados.slice();
      quadro.innerHTML = desenharListaUnica(soFechados);
      caixaFechados.hidden = true;
    }

    atualizarResumo();
    agendarVistos();
  }

  // Três colunas lado a lado: é o desenho que a recepção entende sem
  // treinamento — o cartão anda da esquerda para a direita até sair.
  function desenharColunas(lista) {
    return '<div class="quadro">' + PL.ABERTOS.map(function (s) {
      var doStatus = lista
        .filter(function (p) { return p.status === s; })
        .slice()
        // o mais antigo em cima: quem está esperando há mais tempo é
        // sempre o próximo a ser resolvido
        .sort(function (a, b) { return new Date(a.created_at) - new Date(b.created_at); });

      return '<section class="coluna" data-status="' + PL.esc(s) + '">' +
          '<div class="coluna-head">' +
            "<h2>" + iconeStatus(s) + " " + PL.esc(rotuloStatus(s)) + "</h2>" +
            '<span class="n">' + doStatus.length + "</span>" +
          "</div>" +
          '<div class="coluna-lista">' +
            (doStatus.length
              ? doStatus.map(function (p) { return cartaoDoPedido(p, {}); }).join("")
              : '<p class="hint" style="text-align:center;padding:12px 4px;margin:0">Nada aqui.</p>') +
          "</div>" +
        "</section>";
    }).join("") + "</div>";
  }

  // A ordem já vem decidida por quem chamou: o que está EM ABERTO sobe o
  // mais antigo primeiro (é fila de trabalho), o que já FECHOU mostra o
  // mais recente primeiro (é consulta).
  function desenharListaUnica(lista) {
    if (!lista.length) {
      return '<div class="vazio">' +
        "<b>Nenhum pedido com esse filtro.</b>" +
        "Volte o filtro para <b>Em aberto</b> para ver o movimento do momento." +
      "</div>";
    }
    return '<div class="coluna-lista">' +
      lista.map(function (p) { return cartaoDoPedido(p, { comChip: true }); }).join("") +
      "</div>";
  }

  // ==================================================================
  //  CONTADORES
  //  Contam SEMPRE o dia inteiro, sem olhar o filtro: um pedido atrasado
  //  escondido por um filtro seria o pior defeito possível nesta tela.
  // ==================================================================
  function contarAbertos() {
    var abertos = (PL.pedidos || []).filter(ehAberto);
    var atrasados = abertos.filter(function (p) {
      return PL.minutosDesde(p.created_at) >= slaAtrasado();
    });
    return { abertos: abertos.length, atrasados: atrasados.length };
  }

  function atualizarResumo() {
    var c = contarAbertos();

    var linha = PL.$("#pdResumo", caixaPedidos || document);
    if (linha) {
      var txt = c.abertos
        ? c.abertos + (c.abertos === 1 ? " pedido em aberto" : " pedidos em aberto")
        : "Tudo em dia — nenhum pedido em aberto.";
      if (c.atrasados) {
        txt += " · ⚠ " + c.atrasados +
          (c.atrasados === 1 ? " passou" : " passaram") + " de " + slaAtrasado() + " min";
      }
      linha.textContent = txt;
    }

    atualizarContadorDoTopo(c.abertos);
  }

  // O selo do cabeçalho acompanha a recepção mesmo quando ela está em
  // outra aba do app — por isso ele vive fora desta tela.
  function atualizarContadorDoTopo(quantos) {
    var el = PL.$("#contadorTopo");
    if (!el) return;
    if (!quantos) {
      el.className = "contador zero";
      el.textContent = "";
      el.hidden = true;
      return;
    }
    el.className = "contador";
    el.hidden = false;
    el.innerHTML = "<b>" + quantos + "</b> em aberto";
  }

  function limparContadorDoTopo() {
    var el = PL.$("#contadorTopo");
    if (!el) return;
    el.hidden = true;
    el.textContent = "";
    el.className = "contador";
  }

  // ==================================================================
  //  RELÓGIOS
  //  A cada tique só os números mudam. Redesenhar a tela inteira faria
  //  o dedo perder o botão no meio do toque e a rolagem pular.
  // ==================================================================
  function atualizarRelogios() {
    if (!caixaPedidos) return;
    PL.$$(".pedido[data-relogio]", caixaPedidos).forEach(function (el) {
      var min = PL.minutosDesde(el.dataset.criado);
      var grau = grauDoTempo(min);
      var t = PL.$(".pedido-tempo", el);
      if (t) {
        t.textContent = PL.tempoCurto(min);
        t.className = "pedido-tempo" + (grau ? " " + grau : "");
      }
      el.classList.toggle("atrasado", grau === "atrasado");
      // o destaque do "acabou de chegar" tem hora para acabar
      if (el.classList.contains("novo") && !novos[el.dataset.id]) el.classList.remove("novo");
    });
    atualizarResumo();
  }

  // ==================================================================
  //  PEDIDO NOVO CHEGANDO
  // ==================================================================
  function avisarChegada(chegaram) {
    var agora = Date.now();
    chegaram.forEach(function (p) { novos[p.id] = agora; });

    if (somLigado()) PL.tocarAviso(3);
    PL.vibrar([200, 80, 200]);

    // Um recado curto ajuda quem estava de costas para o tablet.
    PL.aviso(chegaram.length === 1
      ? "🔔 Pedido novo do " + nomeDoQuiosque(chegaram[0])
      : "🔔 " + chegaram.length + " pedidos novos", "avisa");

    // apaga o destaque quando o tempo dele passar
    clearTimeout(chegadaTimer);
    chegadaTimer = guardarTemporizador(setTimeout(function () {
      Object.keys(novos).forEach(function (id) {
        if (Date.now() - novos[id] >= MS_DESTAQUE_NOVO) delete novos[id];
      });
      if (telaViva) desenharPedidos();
    }, MS_DESTAQUE_NOVO + 200));
  }

  // "Visto" só vale se alguém estava mesmo olhando: por isso o atraso e a
  // conferência de que a tela está aberta e na frente.
  function agendarVistos() {
    clearTimeout(vistoTimer);
    vistoTimer = guardarTemporizador(setTimeout(function () {
      if (!telaViva || document.visibilityState !== "visible") return;
      var ids = listaNaTela
        .filter(function (p) { return !p.ack_at && !jaAvisados[p.id]; })
        .map(function (p) { return p.id; });
      if (!ids.length) return;

      ids.forEach(function (id) { jaAvisados[id] = true; });
      Promise.resolve(PL.backend.marcarVistos(ids)).catch(function (e) {
        // deu errado? esquece a marca para tentar de novo no próximo desenho
        ids.forEach(function (id) { delete jaAvisados[id]; });
        console.warn("Marcar como visto:", e);
      });
    }, MS_ATE_MARCAR_VISTO));
  }

  // Repetir o aviso enquanto houver pedido não visto é opcional (fica em
  // repetirSom, no config). Serve para recepção com muito movimento.
  function ligarRepeticaoDoSom() {
    var seg = Number(PL.CFG.repetirSom) || 0;
    if (seg <= 0) return;
    guardarTemporizador(setInterval(function () {
      if (!telaViva || !somLigado()) return;
      if (document.visibilityState !== "visible") return;
      var esquecidos = (PL.pedidos || []).filter(function (p) {
        return p.status === "recebido" && !p.ack_at;
      });
      if (esquecidos.length) PL.tocarAviso(2);
    }, seg * 1000));
  }

  // ==================================================================
  //  OS BOTÕES DO CARTÃO
  // ==================================================================
  function travarCartao(cartao) {
    if (!cartao) return;
    PL.$$(".pedido-acoes .btn", cartao).forEach(function (b) {
      b.disabled = true;
      b.classList.add("disabled");
    });
  }
  function destravarCartao(cartao) {
    if (!cartao) return;
    PL.$$(".pedido-acoes .btn", cartao).forEach(function (b) {
      b.disabled = false;
      b.classList.remove("disabled");
    });
  }

  function pedidoPorId(id) {
    var lista = PL.pedidos || [];
    for (var i = 0; i < lista.length; i++) if (lista[i].id === id) return lista[i];
    return null;
  }

  function cliqueNaTela(ev) {
    var alvo = ev.target.closest("[data-ir], [data-erro], [data-detalhe]");
    if (!alvo) return;
    var cartao = alvo.closest(".pedido");
    if (!cartao) return;
    var p = pedidoPorId(cartao.dataset.id);
    if (!p) return;

    if (alvo.hasAttribute("data-detalhe")) { verItens(p); return; }
    if (alvo.hasAttribute("data-erro"))    { abrirMotivo(p, cartao); return; }

    var destino = alvo.dataset.ir;
    if (!destino) return;

    if (alvo.hasAttribute("data-confirmar")) {
      PL.confirmar({
        titulo: "Reabrir o pedido #" + p.daily_number + "?",
        texto: "Ele volta para a coluna <b>Recebido</b>, como se tivesse acabado de chegar. Use quando o pedido foi fechado por engano.",
        ok: "Reabrir",
      }).then(function (sim) {
        if (sim) aplicarStatus(p, destino, null, cartao);
      });
      return;
    }

    aplicarStatus(p, destino, null, cartao);
  }

  // Trava o cartão inteiro enquanto o banco não responde: com dois toques
  // rápidos o pedido pularia uma etapa e a cozinha ficaria sem aviso.
  function aplicarStatus(p, status, motivo, cartao) {
    travarCartao(cartao);
    return Promise.resolve(PL.backend.mudarStatus(p.id, status, motivo))
      .then(function () { return PL.recarregarPedidos(); })
      .then(function () {
        PL.aviso("Pedido #" + p.daily_number + ": " + rotuloStatus(status).toLowerCase() + ".", "ok");
      })
      .catch(function (e) {
        destravarCartao(cartao);
        PL.aviso(PL.erroLegivel(e), "erro");
      });
  }

  // O cartão compacto esconde os itens; este pop-up mostra o pedido
  // inteiro sem tirar a recepção da tela.
  function verItens(p) {
    var itens = p.itens || [];
    PL.modal({
      titulo: "Pedido #" + p.daily_number + " · " + nomeDoQuiosque(p),
      corpo:
        '<div class="pedido-itens">' +
          (itens.length ? itens.map(linhaDoItem).join("")
                        : '<div class="hint">Este pedido não tem itens registrados.</div>') +
        "</div>" +
        metasDoPedido(p) +
        '<div class="pedido-rodape">' +
          '<span class="pedido-total">' + PL.dinheiro(p.total_cents) + "</span>" +
          '<span class="status-chip status-' + PL.esc(p.status) + '">' +
            PL.esc(rotuloStatus(p.status)) + "</span>" +
        "</div>",
      botoes: [{ texto: "Fechar", classe: "btn-neutral" }],
    });
  }

  // ==================================================================
  //  POP-UP "PEDIU ERRADO"
  //  O banco EXIGE motivo para 'erro' e 'cancelado' — sem motivo o
  //  relatório do fim do mês não explica nada. Por isso os botões de
  //  confirmar só acordam depois que alguém disse o que houve.
  // ==================================================================
  function abrirMotivo(p, cartao) {
    var prontos = Array.isArray(PL.CFG.motivosErro) ? PL.CFG.motivosErro : [];
    var escolhido = "";

    var html =
      '<p class="hint" style="margin:0">Pedido <b>#' + PL.esc(p.daily_number) + "</b> do <b>" +
        PL.esc(nomeDoQuiosque(p)) + "</b> — " + PL.dinheiro(p.total_cents) + ".</p>" +
      (prontos.length
        ? '<div class="motivos">' + prontos.map(function (m) {
            return '<button type="button" class="motivo" data-motivo="' + PL.esc(m) + '">' +
              PL.esc(m) + "</button>";
          }).join("") + "</div>"
        : "") +
      '<label class="field">' +
        "<span>Ou escreva o que aconteceu</span>" +
        '<input type="text" id="mtLivre" maxlength="140" placeholder="ex.: veio pedido do quiosque errado" />' +
      "</label>" +
      '<p class="hint" style="margin:0;line-height:1.5">' +
        "<b>Pediu errado</b> é quando a cozinha <b>já tinha começado</b> — o gasto fica registrado. " +
        "<b>Cancelar</b> é quando <b>nem começou</b>, então não houve prejuízo." +
      "</p>";

    PL.modal({
      titulo: "⚠ Deu problema neste pedido",
      corpo: html,
      botoes: [
        { texto: "Voltar", classe: "btn-neutral" },
        { texto: "Cancelar o pedido", classe: "btn-neutral", id: "mtCancelar",
          acao: function (fechar) {
            if (!escolhido) return;
            fechar();
            aplicarStatus(p, "cancelado", escolhido, cartao);
          } },
        { texto: "Pediu errado", classe: "btn-danger", id: "mtErro",
          acao: function (fechar) {
            if (!escolhido) return;
            fechar();
            aplicarStatus(p, "erro", escolhido, cartao);
          } },
      ],
      aoAbrir: function (corpo, api) {
        var btErro = api.fundo.querySelector("#mtErro");
        var btCancelar = api.fundo.querySelector("#mtCancelar");
        var livre = PL.$("#mtLivre", corpo);

        function conferir() {
          var pode = !!escolhido;
          [btErro, btCancelar].forEach(function (b) {
            if (!b) return;
            b.disabled = !pode;
            b.classList.toggle("disabled", !pode);
          });
        }
        conferir();

        // clicar num motivo pronto seleciona (e desmarca os outros)
        PL.$$(".motivo", corpo).forEach(function (b) {
          b.addEventListener("click", function () {
            var jaEra = b.classList.contains("is-sel");
            PL.$$(".motivo", corpo).forEach(function (x) { x.classList.remove("is-sel"); });
            if (jaEra) { escolhido = ""; }
            else { b.classList.add("is-sel"); escolhido = b.dataset.motivo; livre.value = ""; }
            conferir();
          });
        });

        // texto escrito à mão vence o botão pronto
        livre.addEventListener("input", function () {
          var t = livre.value.trim();
          if (t) {
            PL.$$(".motivo", corpo).forEach(function (x) { x.classList.remove("is-sel"); });
            escolhido = t;
          } else {
            escolhido = "";
          }
          conferir();
        });
      },
    });
  }

  // ==================================================================
  //  TELA "HISTÓRICO"
  //  A mesma informação do quadro, em forma de tabela: serve para
  //  conferir o caixa no fim do dia e para achar "aquele pedido".
  // ==================================================================
  function montarHistorico(caixa) {
    histViva = true;
    caixaHist = caixa;
    lerFiltros();

    caixa.innerHTML =
      '<section class="card">' +
        '<div class="card-head">' +
          '<h1 class="card-title">📜 Histórico de hoje</h1>' +
          '<div class="filtros">' +
            '<select id="hsQuiosque" aria-label="Filtrar por quiosque">' +
              opcoesDeQuiosque(filtros.hQuiosque) + "</select>" +
            '<select id="hsStatus" aria-label="Filtrar por situação">' +
              opcoesDeStatus(filtros.hStatus, false) + "</select>" +
            '<button type="button" class="btn btn-sm btn-outline" id="hsCsv">⬇ Exportar CSV</button>' +
          "</div>" +
        "</div>" +
        '<div class="pedido-meta" id="hsResumo"></div>' +
      "</section>" +
      '<section class="card">' +
        '<div class="tabela-rolagem" id="hsTabela"></div>' +
      "</section>";

    PL.$("#hsQuiosque", caixa).addEventListener("change", function () {
      filtros.hQuiosque = this.value; gravarFiltros(); desenharHistorico();
    });
    PL.$("#hsStatus", caixa).addEventListener("change", function () {
      filtros.hStatus = this.value; gravarFiltros(); desenharHistorico();
    });
    PL.$("#hsCsv", caixa).addEventListener("click", function () {
      exportarCsv(listaDoHistorico());
    });

    desenharHistorico();
  }

  function listaDoHistorico() {
    return (PL.pedidos || [])
      .filter(function (p) {
        if (filtros.hQuiosque && p.kiosk_id !== filtros.hQuiosque) return false;
        if (filtros.hStatus !== "todos" && p.status !== filtros.hStatus) return false;
        return true;
      })
      .slice()
      // do primeiro do dia para o último: é assim que se confere um caixa
      .sort(function (a, b) { return (a.daily_number || 0) - (b.daily_number || 0); });
  }

  // O resumo em uma linha de pílulas — o que o dono pergunta primeiro.
  function desenharResumoDoDia(lista) {
    var el = PL.$("#hsResumo", caixaHist || document);
    if (!el) return;

    var faturado = lista
      .filter(function (p) { return p.status !== "erro" && p.status !== "cancelado"; })
      .reduce(function (s, p) { return s + (Number(p.total_cents) || 0); }, 0);

    var tempos = lista
      .map(function (p) { return minutosEntre(p.created_at, p.delivered_at); })
      .filter(function (m) { return m !== null; });
    var media = tempos.length
      ? Math.round(tempos.reduce(function (s, m) { return s + m; }, 0) / tempos.length)
      : null;

    var errados = lista.filter(function (p) {
      return p.status === "erro" || p.status === "cancelado";
    }).length;

    el.innerHTML =
      '<span class="meta"><b>' + lista.length + "</b> " +
        (lista.length === 1 ? "pedido" : "pedidos") + "</span>" +
      '<span class="meta"><b>' + PL.dinheiro(faturado) + "</b> em pedidos válidos</span>" +
      '<span class="meta">entrega em média ' +
        (media === null ? "—" : "<b>" + PL.esc(PL.tempoCurto(media)) + "</b>") + "</span>" +
      (errados
        ? '<span class="meta erro">' + errados +
          (errados === 1 ? " deu errado" : " deram errado") + "</span>"
        : '<span class="meta">nenhum deu errado</span>');
  }

  function resumoDosItens(p) {
    var itens = p.itens || [];
    if (!itens.length) return "—";
    return itens.map(function (it) {
      return (Number(it.qty) || 1) + "× " + it.product_name;
    }).join(", ");
  }

  function desenharHistorico() {
    if (!caixaHist) return;
    var lista = listaDoHistorico();
    desenharResumoDoDia(lista);

    var alvo = PL.$("#hsTabela", caixaHist);
    if (!lista.length) {
      alvo.innerHTML = (PL.pedidos || []).length
        ? '<div class="vazio"><b>Nenhum pedido com esse filtro.</b>Troque o quiosque ou a situação aí em cima.</div>'
        : '<div class="vazio"><b>Nenhum pedido ainda hoje.</b>Quando um quiosque pedir, ele aparece aqui na hora.</div>';
      return;
    }

    var linhas = lista.map(function (p) {
      var gasto = minutosEntre(p.created_at, p.delivered_at);
      var resumo = resumoDosItens(p);
      return "<tr>" +
        "<td><b>#" + PL.esc(p.daily_number) + "</b></td>" +
        "<td>" + PL.esc(PL.hora(p.created_at)) + "</td>" +
        "<td>" + PL.esc(nomeDoQuiosque(p)) + "</td>" +
        '<td title="' + PL.esc(resumo) + '">' + PL.esc(resumo) + "</td>" +
        '<td class="num">' + PL.dinheiro(p.total_cents) + "</td>" +
        '<td><span class="status-chip status-' + PL.esc(p.status) + '">' +
          PL.esc((PL.STATUS[p.status] || {}).curto || p.status) + "</span></td>" +
        '<td class="num">' + (gasto === null ? "—" : PL.esc(PL.tempoCurto(gasto))) + "</td>" +
      "</tr>";
    }).join("");

    alvo.innerHTML =
      '<table class="tabela">' +
        "<thead><tr>" +
          "<th>Nº</th><th>Hora</th><th>Quiosque</th><th>Itens</th>" +
          '<th class="num">Total</th><th>Situação</th><th class="num">Até entregar</th>' +
        "</tr></thead>" +
        "<tbody>" + linhas + "</tbody>" +
      "</table>";
  }

  // ==================================================================
  //  EXPORTAR CSV
  //  Feito à mão, sem biblioteca nenhuma: funciona no tablet mesmo com a
  //  internet oscilando, porque o arquivo nasce dentro do navegador.
  //  Padrão brasileiro: ponto-e-vírgula separando e vírgula no centavo —
  //  é o que o Excel em português espera ao abrir com dois cliques.
  // ==================================================================
  function campoCsv(valor) {
    var t = String(valor === null || valor === undefined ? "" : valor).replace(/\r?\n/g, " ");
    return /[";]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }

  function dinheiroCsv(centavos) {
    return ((Number(centavos) || 0) / 100).toFixed(2).replace(".", ",");
  }

  function exportarCsv(lista) {
    if (!lista || !lista.length) {
      PL.aviso("Não há pedidos para exportar.", "avisa");
      return;
    }

    var linhas = [[
      "Nº", "Hora", "Quiosque", "Cliente", "Lugar", "Itens", "Qtd. itens",
      "Total (R$)", "Situação", "Minutos até entregar", "Observação", "Motivo do erro",
    ]];

    lista.forEach(function (p) {
      var gasto = minutosEntre(p.created_at, p.delivered_at);
      linhas.push([
        p.daily_number,
        PL.hora(p.created_at),
        nomeDoQuiosque(p),
        p.customer_name || "",
        p.table_label || "",
        resumoDosItens(p),
        quantosItens(p),
        dinheiroCsv(p.total_cents),
        rotuloStatus(p.status),
        gasto === null ? "" : gasto,
        p.notes || "",
        p.error_reason || "",
      ]);
    });

    // O "\uFEFF" na frente é uma marca invisível que avisa o Excel de que
    // o arquivo está em UTF-8. Sem ela, "Porção" abre escrito "PorÃ§Ã£o" e
    // o dono acha que o sistema quebrou.
    var texto = "\uFEFF" + linhas.map(function (l) {
      return l.map(campoCsv).join(";");
    }).join("\r\n");

    var dia = PL.hojeNoFuso(PL.ctx && PL.ctx.cliente ? PL.ctx.cliente.timezone : null);
    var marca = (PL.ctx && PL.ctx.cliente && PL.ctx.cliente.slug) || "pedidos";
    var blob = new Blob([texto], { type: "text/csv;charset=utf-8;" });

    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pedidos-" + marca + "-" + dia + ".csv";
    document.body.appendChild(a);
    a.click();
    // o navegador precisa de um instante com o link ainda vivo antes de
    // soltarmos a memória do arquivo
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1500);

    PL.aviso("Arquivo gerado: " + lista.length + " pedidos.", "ok");
  }

  // ==================================================================
  //  AVISOS DO NÚCLEO
  //  Ficam fora das telas de propósito: o som do pedido novo tem que
  //  tocar mesmo se a recepção estiver na aba do histórico.
  // ==================================================================
  PL.ao("pedidos", function (dados) {
    var chegaram = (dados && dados.chegaram) || [];

    if (chegaram.length && PL.ehEquipe()) avisarChegada(chegaram);

    // Fora da tela de pedidos o selo do cabeçalho continua vivo: o admin
    // mexendo no cardápio precisa ver que tem gente esperando.
    if (telaViva) desenharPedidos();
    else if (PL.ehEquipe()) atualizarContadorDoTopo(contarAbertos().abertos);
    if (histViva) desenharHistorico();
  });

  PL.ao("tique", function () {
    if (telaViva) atualizarRelogios();
  });

  // Quiosque novo, ou quiosque renomeado, muda o texto dos cartões.
  PL.ao("catalogo", function () {
    if (telaViva) desenharPedidos();
    if (histViva) desenharHistorico();
  });

  // ==================================================================
  //  REGISTRO DAS TELAS
  // ==================================================================
  PL.registrarTela({
    id: "pedidos",
    rotulo: "Pedidos",
    icone: "🔔",
    ordem: 5,
    papeis: ["recepcao", "admin"],

    montar: montarPedidos,

    aoEntrar: function () {
      telaViva = true;
      ligarRepeticaoDoSom();
      atualizarResumo();
      agendarVistos();
    },

    aoSair: function () {
      telaViva = false;
      // o #conteudo é o mesmo elemento em todas as telas: deixar o ouvinte
      // ligado seria pisar no clique das outras abas
      if (caixaPedidos) caixaPedidos.removeEventListener("click", cliqueNaTela);
      caixaPedidos = null;
      listaNaTela = [];
      limparTemporizadores();

      // O selo do cabeçalho NÃO some ao sair desta aba — é justamente fora
      // dela que ele serve: o admin mexendo no cardápio precisa continuar
      // vendo que tem pedido esperando. Só apagamos para o quiosque, que
      // não tem nada a fazer com esse número.
      if (PL.ehEquipe()) atualizarContadorDoTopo(contarAbertos().abertos);
      else limparContadorDoTopo();
    },

    // A engrenagem ⚙ da barra de cima, quando esta aba está aberta,
    // configura ESTA aba. Quem sabe fazer isso é o admin.js — se ele
    // ainda não estiver carregado, avisamos em vez de quebrar.
    engrenagem: function () {
      if (window.PLAdmin && typeof window.PLAdmin.configurarPedidos === "function") {
        window.PLAdmin.configurarPedidos();
        return;
      }
      PL.aviso("As configurações do quadro de pedidos ainda não estão disponíveis.", "avisa");
    },
  });

  PL.registrarTela({
    id: "historico",
    rotulo: "Histórico",
    icone: "📜",
    ordem: 30,
    papeis: ["recepcao", "admin"],

    montar: montarHistorico,

    aoEntrar: function () { histViva = true; },

    aoSair: function () {
      histViva = false;
      caixaHist = null;
    },
  });
})();
