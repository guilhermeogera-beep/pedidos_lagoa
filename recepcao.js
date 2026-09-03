/* ============================================================
   PEDIDOS LAGOA — RECEPÇÃO
   ============================================================
   As DUAS telas de quem fica no balcão:

     "Pedidos"   → o quadro ao vivo. É o coração do sistema: o que
                   o quiosque pediu aparece aqui na hora, com som,
                   e a recepção resolve com um toque.
     "Histórico" → a tabela do dia, com resumo e exportação para o
                   Excel (fechamento de caixa).

   O CAMINHO É CURTO DE PROPÓSITO. Chega, a recepção lança, acabou:

       recebido → [Lancei o pedido] → lançado

   Não existe etapa no meio. Um sistema que pede três toques por
   pedido é um sistema que, no movimento, ninguém usa — e aí a
   recepção volta a anotar em papel.

   Os dois botões de exceção continuam: "pediu errado" (quando já
   houve gasto) e "cancelar" (quando não houve).

   Nada aqui conversa com o banco direto: tudo passa por PL.backend.
   Assim o modo demonstração e o modo nuvem se comportam igual.

   Nomes vindos do banco ficam em inglês (created_at, daily_number,
   total_cents...) — é o mesmo nome que está na tabela do Supabase.
   ============================================================ */
(function () {
  "use strict";

  var PL = window.PL;

  var LS_FILTROS = "pedidos_lagoa_filtros";

  // Tempo que o cartão recém-chegado fica com a moldura âmbar. 12 s dá
  // para o olho achar o cartão novo sem a tela virar árvore de natal.
  var MS_DESTAQUE_NOVO = 12000;

  // Espera antes de dizer ao banco "eu vi este pedido". Marcar na hora
  // seria mentira: o cartão pode ter aparecido com a recepção de costas.
  var MS_ATE_MARCAR_VISTO = 4000;

  // ------------------------------------------------------------------
  //  ESTADO DESTE ARQUIVO
  // ------------------------------------------------------------------
  var filtros = {
    quiosque: "",        // "" = todos
    som: true,
    hQuiosque: "",       // filtros da tela de histórico
    hStatus: "todos",
  };

  var telaViva = false;
  var histViva = false;
  var caixaPedidos = null;
  var caixaHist = null;
  var temporizadores = [];
  var vistoTimer = null;
  var chegadaTimer = null;
  var novos = {};              // id do pedido -> hora em que ele apareceu
  var jaAvisados = {};         // ids já mandados para o "marcar como visto"
  var naTela = [];             // o que está desenhado neste momento

  // ==================================================================
  //  FILTROS GUARDADOS
  //  Ficam no aparelho (e não na nuvem) de propósito: o tablet da
  //  recepção pode estar filtrado sem bagunçar o do administrador.
  // ==================================================================
  function lerFiltros() {
    try {
      var g = JSON.parse(localStorage.getItem(LS_FILTROS) || "{}");
      if (g && typeof g === "object") filtros = Object.assign(filtros, g);
    } catch (e) { /* aparelho sem localStorage: segue com o padrão */ }
    if (PL.CFG.somPedidoNovo === false) filtros.som = false;
  }

  function gravarFiltros() {
    try { localStorage.setItem(LS_FILTROS, JSON.stringify(filtros)); } catch (e) {}
  }

  // ==================================================================
  //  PEQUENAS AJUDAS
  // ==================================================================

  // O pedido traz o quiosque junto (join do banco), mas nem sempre: numa
  // conexão ruim ele pode vir vazio. Aí procuramos pelo kiosk_id no
  // catálogo, e só desistimos depois disso — a recepção NUNCA pode ficar
  // sem saber de quem é o pedido.
  function nomeDoQuiosque(p) {
    if (p.quiosque && (p.quiosque.name || p.quiosque.number)) {
      return p.quiosque.name || ("Quiosque " + p.quiosque.number);
    }
    var lista = (PL.catalogo && PL.catalogo.quiosques) || [];
    for (var i = 0; i < lista.length; i++) {
      if (lista[i].id === p.kiosk_id) return lista[i].name || ("Quiosque " + lista[i].number);
    }
    return "Quiosque ?";
  }

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

  function rotuloStatus(s) { return (PL.STATUS[s] && PL.STATUS[s].rotulo) || s || "?"; }
  function curtoStatus(s)  { return (PL.STATUS[s] && PL.STATUS[s].curto)  || s || "?"; }
  function iconeStatus(s)  { return (PL.STATUS[s] && PL.STATUS[s].icone)  || ""; }

  function somLigado() { return PL.CFG.somPedidoNovo !== false && filtros.som !== false; }

  function ehNovo(p) { return !!novos[p.id] && (Date.now() - novos[p.id]) < MS_DESTAQUE_NOVO; }

  function guardarTemporizador(t) { temporizadores.push(t); return t; }

  function limparTemporizadores() {
    temporizadores.forEach(function (t) { clearTimeout(t); clearInterval(t); });
    temporizadores = [];
    vistoTimer = null;
    chegadaTimer = null;
  }

  // ==================================================================
  //  O CARTÃO DO PEDIDO
  // ==================================================================
  function botao(classe, texto, atributos) {
    return '<button type="button" class="btn ' + classe + '" ' + (atributos || "") + ">" +
      PL.esc(texto) + "</button>";
  }

  // Um botão grande e dois pequenos. O grande é o que acontece 95% das
  // vezes; os outros dois são exceção e ficam menores de propósito, para
  // o dedo apressado não errar.
  function acoesDoPedido(p) {
    if (!ehAberto(p)) {
      return botao("btn-neutral btn-sm", "↺ Reabrir", 'data-ir="recebido" data-confirmar="1"');
    }
    return botao("btn-ok", "✅ Lancei o pedido", 'data-ir="lancado"') +
           botao("btn-danger btn-sm", "⚠ Cancelar", 'data-erro="1"');
  }

  function linhaDoItem(it) {
    var obs = it.notes ? '<span class="pi-obs">↳ ' + PL.esc(it.notes) + "</span>" : "";
    return '<div class="pi">' +
        '<span class="pi-qtd">' + PL.esc(it.qty) + "×</span>" +
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

  // opcoes.compacto → cartão do "Resolvidos hoje" (sem a lista de itens)
  function cartaoDoPedido(p, opcoes) {
    var o = opcoes || {};
    var aberto = ehAberto(p);
    var min = PL.minutosDesde(p.created_at);
    var grau = aberto ? grauDoTempo(min) : "";
    var itens = p.itens || [];

    var canto;
    if (aberto) {
      canto = '<span class="pedido-tempo' + (grau ? " " + grau : "") + '">' +
                PL.esc(PL.tempoCurto(min)) + "</span>";
    } else {
      // Só o pedido LANÇADO mostra quanto o quiosque esperou. Num pedido
      // errado esse número não quer dizer nada — e "ERRADO · agora"
      // parece que alguma coisa acabou de dar errado neste instante.
      var gasto = p.status === "lancado" ? minutosEntre(p.created_at, p.launched_at) : null;
      canto = '<span class="status-chip status-' + PL.esc(p.status) + '">' +
                PL.esc(curtoStatus(p.status)) +
                (gasto === null ? "" : " · " + PL.esc(PL.tempoCurto(gasto))) +
              "</span>";
    }

    var corpoItens = o.compacto
      ? ""
      : '<div class="pedido-itens">' + (itens.length
          ? itens.map(linhaDoItem).join("")
          : '<div class="hint">Este pedido chegou sem itens — confira com o quiosque.</div>') + "</div>";

    var verItens = o.compacto
      ? botao("btn-neutral btn-sm", "👁 Ver itens", 'data-detalhe="1"')
      : "";

    var classes = "pedido" +
      (ehNovo(p) ? " novo" : "") +
      (aberto && grau === "atrasado" ? " atrasado" : "");

    return '<article class="' + classes + '" data-status="' + PL.esc(p.status) + '"' +
             ' data-id="' + PL.esc(p.id) + '"' +
             (aberto ? ' data-criado="' + PL.esc(p.created_at) + '"' : "") + ">" +
        '<div class="pedido-topo">' +
          '<div class="pedido-quiosque">' +
            "<b>" + PL.esc(nomeDoQuiosque(p)) + "</b>" +
            '<span class="pedido-num">Pedido #' + PL.esc(p.daily_number) +
              " · " + PL.esc(PL.hora(p.created_at)) + "</span>" +
          "</div>" +
          canto +
        "</div>" +
        corpoItens +
        metasDoPedido(p) +
        '<div class="pedido-rodape">' +
          '<span class="pedido-total">' + PL.dinheiro(p.total_cents) + "</span>" +
          '<div class="pedido-acoes">' + verItens + acoesDoPedido(p) + "</div>" +
        "</div>" +
      "</article>";
  }

  // ==================================================================
  //  TELA "PEDIDOS"
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

  function opcoesDeStatus(escolhido) {
    var html = '<option value="todos"' + (escolhido === "todos" ? " selected" : "") + ">Todos</option>";
    Object.keys(PL.STATUS).forEach(function (s) {
      html += '<option value="' + PL.esc(s) + '"' + (s === escolhido ? " selected" : "") + ">" +
        iconeStatus(s) + " " + PL.esc(rotuloStatus(s)) + "</option>";
    });
    return html;
  }

  function passaNoFiltro(p) {
    return !filtros.quiosque || p.kiosk_id === filtros.quiosque;
  }

  function montarPedidos(caixa) {
    telaViva = true;
    caixaPedidos = caixa;
    lerFiltros();

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
            switchSom +
            '<button type="button" class="btn btn-sm btn-outline" id="pdImprimir">🖨️ Imprimir</button>' +
            '<button type="button" class="btn btn-sm btn-accent" id="pdEncerrar" hidden>🔄 Encerrar contas</button>' +
          "</div>" +
        "</div>" +
        '<p class="hint" id="pdResumo"></p>' +
      "</section>" +
      '<section class="card" id="pdAbertos"></section>' +
      '<section class="card" id="pdFechados" hidden></section>';

    // Um ouvinte só para a tela inteira: os cartões são redesenhados o
    // tempo todo, e um ouvinte por botão viraria lixo acumulado.
    // O núcleo esvazia o #conteudo mas reaproveita o MESMO elemento, então
    // tiramos o ouvinte antes de pôr — senão, quem entra e sai da aba três
    // vezes acaba lançando o mesmo pedido três vezes.
    caixa.removeEventListener("click", cliqueNaTela);
    caixa.addEventListener("click", cliqueNaTela);

    PL.$("#pdQuiosque", caixa).addEventListener("change", function () {
      filtros.quiosque = this.value; gravarFiltros(); desenharPedidos();
    });
    var som = PL.$("#pdSom", caixa);
    if (som) {
      som.addEventListener("change", function () {
        filtros.som = this.checked;
        gravarFiltros();
        PL.aviso(this.checked ? "Som ligado." : "Som desligado.", "ok");
        // toca uma vez ao ligar: dá para conferir o volume antes do movimento
        if (this.checked) PL.tocarAviso(1);
      });
    }
    PL.$("#pdImprimir", caixa).addEventListener("click", function () { window.print(); });
    PL.$("#pdEncerrar", caixa).addEventListener("click", abrirEncerrarContas);

    desenharPedidos();
    atualizarBotaoEncerrar();
  }

  // ==================================================================
  //  ENCERRAR AS CONTAS DOS QUIOSQUES  (a virada do turno)
  //  ------------------------------------------------------------------
  //  Tem dia com pesca de dia e pesca de noite: o mesmo quiosque troca de
  //  gente. A conta de quem foi embora não pode aparecer para quem chega.
  //
  //  O botão aparece a partir da hora configurada (18h por padrão). Por
  //  padrão ele encerra TODAS as contas — e a recepção marca as exceções,
  //  os quiosques que vão virar a noite. É de propósito nessa ordem: quem
  //  esquece de marcar termina com o quadro limpo, que é o erro barato.
  //  O contrário deixaria a conta do almoço na mão de quem chegou à noite.
  //
  //  E se ninguém tocar em nada, tudo zera sozinho na hora da virada.
  // ==================================================================
  function atualizarBotaoEncerrar() {
    var b = PL.$("#pdEncerrar", caixaPedidos || document);
    if (!b) return;
    b.hidden = !PL.horaDeEncerrar();
  }

  function abrirEncerrarContas() {
    var quiosques = ((PL.catalogo && PL.catalogo.quiosques) || [])
      .filter(function (q) { return q.active !== false; })
      .slice()
      .sort(function (a, b) { return (Number(a.number) || 0) - (Number(b.number) || 0); });

    if (!quiosques.length) {
      PL.aviso("Nenhum quiosque ativo.", "avisa");
      return;
    }

    // o que cada quiosque consumiu na conta que está aberta agora
    var linhas = quiosques.map(function (q) {
      var doTurno = PL.pedidosDaSessao(q);
      var valem = doTurno.filter(function (p) { return p.status !== "cancelado" && p.status !== "erro"; });
      return {
        q: q,
        pedidos: valem.length,
        abertos: doTurno.filter(ehAberto).length,
        total: valem.reduce(function (s, p) { return s + (Number(p.total_cents) || 0); }, 0),
        desde: PL.inicioDaSessao(q),
      };
    });

    var comMovimento = linhas.filter(function (l) { return l.pedidos > 0; });

    var html =
      '<p class="hint" style="margin:0;line-height:1.6">' +
        "Encerrar a conta zera o que o quiosque consumiu — o novo pescador começa do zero. " +
        "<b>Marque abaixo só os quiosques que vão continuar a pescaria</b>; o resto é encerrado." +
      "</p>" +
      (comMovimento.length
        ? '<div class="lista-edit">' + linhas.map(function (l) {
            var vazio = l.pedidos === 0;
            return '<div class="le' + (vazio ? " inativo" : "") + '" data-id="' + PL.esc(l.q.id) + '">' +
                '<div class="le-info">' +
                  '<div class="le-nome"><b>#' + PL.esc(l.q.number) + "</b> " + PL.esc(l.q.name) + "</div>" +
                  '<div class="le-sub">' +
                    (vazio ? "sem consumo nesta conta"
                           : l.pedidos + (l.pedidos === 1 ? " pedido · " : " pedidos · ") +
                             PL.dinheiro(l.total) +
                             (l.abertos ? " · ⚠ " + l.abertos + " ainda a lançar" : "")) +
                    " · desde " + PL.esc(PL.hora(new Date(l.desde).toISOString())) +
                  "</div>" +
                "</div>" +
                '<div class="le-acoes">' +
                  '<label class="switch" title="Este quiosque continua a pescaria">' +
                    '<input type="checkbox" data-continua="' + PL.esc(l.q.id) + '" />' +
                    '<span class="trilho"></span><span>Continua</span>' +
                  "</label>" +
                "</div>" +
              "</div>";
          }).join("") + "</div>"
        : '<div class="vazio"><b>Nenhum quiosque com consumo.</b>Não há conta para encerrar agora.</div>') +
      '<p class="form-msg" id="encMsg" role="status"></p>';

    PL.modal({
      titulo: "🔄 Encerrar as contas dos quiosques",
      larga: true,
      corpo: html,
      botoes: [
        { texto: "Voltar", classe: "btn-neutral" },
        { texto: "Encerrar as contas", classe: "btn-accent", id: "encOk",
          acao: function (fechar, api) { confirmarEncerramento(linhas, fechar, api); } },
      ],
      aoAbrir: function (corpo, api) {
        function contar() {
          var continuam = PL.$$("[data-continua]", corpo).filter(function (i) { return i.checked; }).length;
          var fecham = linhas.length - continuam;
          var bt = api.fundo.querySelector("#encOk");
          if (bt) {
            bt.textContent = fecham
              ? "Encerrar " + fecham + (fecham === 1 ? " conta" : " contas")
              : "Nenhuma para encerrar";
            bt.disabled = fecham === 0;
          }
        }
        corpo.addEventListener("change", contar);
        contar();
      },
    });
  }

  async function confirmarEncerramento(linhas, fechar, api) {
    var corpo = api.corpo;
    var continuam = {};
    PL.$$("[data-continua]", corpo).forEach(function (i) {
      if (i.checked) continuam[i.getAttribute("data-continua")] = true;
    });

    var vaoFechar = linhas.filter(function (l) { return !continuam[l.q.id]; });
    if (!vaoFechar.length) return;

    // Conta ainda com pedido não lançado é sinal de gente esperando comida.
    // Encerrar sem avisar seria o pior tipo de silêncio.
    var pendentes = vaoFechar.filter(function (l) { return l.abertos > 0; });
    if (pendentes.length) {
      var certeza = await PL.confirmar({
        titulo: "Tem pedido esperando",
        texto: pendentes.map(function (l) {
          return "<b>" + PL.esc(l.q.name) + "</b>: " + l.abertos +
            (l.abertos === 1 ? " pedido ainda não lançado" : " pedidos ainda não lançados");
        }).join("<br>") +
        "<br><br>Eles <b>continuam no quadro</b> depois de encerrar a conta — não somem. " +
        "Mas confira se não há alguém esperando antes de virar o turno.",
        ok: "Encerrar mesmo assim", cancelar: "Voltar e resolver", perigo: true,
      });
      if (!certeza) return;
    }

    var bt = api.fundo.querySelector("#encOk");
    if (bt) { bt.disabled = true; bt.textContent = "Encerrando…"; }

    try {
      await PL.backend.fecharSessoes(vaoFechar.map(function (l) { return l.q.id; }));
      await PL.recarregarCatalogo();
      await PL.recarregarPedidos();
      fechar();
      PL.aviso(vaoFechar.length + (vaoFechar.length === 1 ? " conta encerrada." : " contas encerradas."), "ok");
    } catch (e) {
      console.error("Encerrar contas:", e);
      var msg = PL.$("#encMsg", corpo);
      if (msg) msg.textContent = PL.erroLegivel(e);
      if (bt) { bt.disabled = false; bt.textContent = "Encerrar as contas"; }
    }
  }

  function desenharPedidos() {
    if (!caixaPedidos) return;

    var todos = PL.pedidos || [];
    var doQuiosque = todos.filter(passaNoFiltro);
    var abertos = doQuiosque.filter(ehAberto)
      .slice()
      // o mais antigo em cima: quem espera há mais tempo é o próximo
      .sort(function (a, b) { return new Date(a.created_at) - new Date(b.created_at); });

    var fechados = doQuiosque.filter(function (p) { return !ehAberto(p); })
      .slice()
      .sort(function (a, b) {
        return new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at);
      });

    naTela = abertos.slice();

    var areaAbertos = PL.$("#pdAbertos", caixaPedidos);
    var areaFechados = PL.$("#pdFechados", caixaPedidos);

    // ---- a fila de trabalho ----
    if (!todos.length) {
      areaAbertos.innerHTML =
        '<div class="vazio">' +
          "<b>Nenhum pedido ainda hoje.</b>" +
          "Quando um quiosque pedir, ele aparece aqui na hora." +
        "</div>";
    } else if (!abertos.length) {
      areaAbertos.innerHTML =
        '<div class="vazio">' +
          "<b>Tudo lançado. 👏</b>" +
          "Nenhum pedido esperando" + (filtros.quiosque ? " neste quiosque" : "") + " no momento." +
        "</div>";
    } else {
      areaAbertos.innerHTML =
        '<div class="card-head">' +
          '<h2 class="card-title">📥 A lançar</h2>' +
          '<span class="n-grande">' + abertos.length + "</span>" +
        "</div>" +
        '<div class="fila-pedidos">' + abertos.map(function (p) { return cartaoDoPedido(p, {}); }).join("") + "</div>";
    }

    // ---- o que já foi resolvido hoje ----
    var limite = Number(PL.CFG.mostrarEntreguesHoje);
    if (!(limite > 0)) limite = 20;
    var mostrar = fechados.slice(0, limite);
    naTela = naTela.concat(mostrar);

    if (!fechados.length) {
      areaFechados.hidden = true;
      areaFechados.innerHTML = "";
    } else {
      areaFechados.hidden = false;
      areaFechados.innerHTML =
        '<div class="card-head">' +
          '<h2 class="card-title">✅ Resolvidos hoje</h2>' +
          '<span class="hint">' + fechados.length +
            (fechados.length === 1 ? " pedido" : " pedidos") +
            (fechados.length > mostrar.length ? " · mostrando os " + mostrar.length + " últimos" : "") +
          "</span>" +
        "</div>" +
        '<div class="fila-pedidos">' +
          mostrar.map(function (p) { return cartaoDoPedido(p, { compacto: true }); }).join("") +
        "</div>";
    }

    atualizarResumo();
    agendarVistos();
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
        ? c.abertos + (c.abertos === 1 ? " pedido esperando" : " pedidos esperando")
        : "Tudo em dia — nenhum pedido esperando.";
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
    el.innerHTML = "<b>" + quantos + "</b> a lançar";
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
  //  A cada tique só os números mudam. Redesenhar a tela inteira faria o
  //  dedo perder o botão no meio do toque e a rolagem pular.
  // ==================================================================
  function atualizarRelogios() {
    if (!caixaPedidos) return;
    PL.$$(".pedido[data-criado]", caixaPedidos).forEach(function (el) {
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
      var ids = naTela
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

  // Repetir o aviso enquanto houver pedido esperando é opcional (repetirSom).
  // Serve para recepção com muito movimento.
  function ligarRepeticaoDoSom() {
    var seg = Number(PL.CFG.repetirSom) || 0;
    if (seg <= 0) return;
    guardarTemporizador(setInterval(function () {
      if (!telaViva || !somLigado()) return;
      if (document.visibilityState !== "visible") return;
      var esquecidos = (PL.pedidos || []).filter(function (p) {
        return p.status === "recebido";
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
        texto: "Ele volta para a fila de <b>a lançar</b>, como se tivesse acabado de chegar. Use quando foi fechado por engano.",
        ok: "Reabrir",
      }).then(function (sim) {
        if (sim) aplicarStatus(p, destino, null, cartao);
      });
      return;
    }

    aplicarStatus(p, destino, null, cartao);
  }

  // Trava o cartão inteiro enquanto o banco não responde: com dois toques
  // rápidos o mesmo pedido seria lançado duas vezes.
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
  //  POP-UP "DEU PROBLEMA"
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
        "O motivo é <b>obrigatório</b> e vai junto com o pedido: o quiosque enxerga " +
        "o que você escreveu, e ele entra no relatório do fim do dia. Sem motivo, " +
        "ninguém consegue explicar depois por que aquele pedido não saiu." +
      "</p>";

    PL.modal({
      titulo: "⚠ Cancelar este pedido",
      corpo: html,
      botoes: [
        { texto: "Voltar", classe: "btn-neutral" },
        // Um botão só. Antes eram dois ("pediu errado" e "cancelar") e a
        // recepção tinha que escolher entre os dois no meio do movimento —
        // sendo que o MOTIVO conta essa história melhor do que o rótulo.
        { texto: "Escolha o motivo", classe: "btn-danger", id: "mtConfirmar",
          acao: function (fechar) {
            if (!escolhido) return;
            fechar();
            aplicarStatus(p, "cancelado", escolhido, cartao);
          } },
      ],
      aoAbrir: function (corpo, api) {
        var btConfirmar = api.fundo.querySelector("#mtConfirmar");
        var livre = PL.$("#mtLivre", corpo);

        // O botão nasce travado e só acorda quando existe um motivo — e o
        // próprio texto dele diz o que falta. É mais honesto do que deixar
        // clicar para reclamar depois.
        function conferir() {
          var pode = !!escolhido;
          if (!btConfirmar) return;
          btConfirmar.disabled = !pode;
          btConfirmar.classList.toggle("disabled", !pode);
          btConfirmar.textContent = pode ? "Confirmar cancelamento" : "Escolha o motivo";
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
              opcoesDeStatus(filtros.hStatus) + "</select>" +
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
      .map(function (p) { return minutosEntre(p.created_at, p.launched_at); })
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
      '<span class="meta">lançado em média em ' +
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
      var gasto = minutosEntre(p.created_at, p.launched_at);
      var resumo = resumoDosItens(p);
      return "<tr>" +
        "<td><b>#" + PL.esc(p.daily_number) + "</b></td>" +
        "<td>" + PL.esc(PL.hora(p.created_at)) + "</td>" +
        "<td>" + PL.esc(nomeDoQuiosque(p)) + "</td>" +
        '<td title="' + PL.esc(resumo) + '">' + PL.esc(resumo) + "</td>" +
        '<td class="num">' + PL.dinheiro(p.total_cents) + "</td>" +
        '<td><span class="status-chip status-' + PL.esc(p.status) + '">' +
          PL.esc(curtoStatus(p.status)) + "</span></td>" +
        '<td class="num">' + (gasto === null ? "—" : PL.esc(PL.tempoCurto(gasto))) + "</td>" +
      "</tr>";
    }).join("");

    alvo.innerHTML =
      '<table class="tabela">' +
        "<thead><tr>" +
          "<th>Nº</th><th>Hora</th><th>Quiosque</th><th>Itens</th>" +
          '<th class="num">Total</th><th>Situação</th><th class="num">Até lançar</th>' +
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
    // texto começando com = + - @ o Excel abriria como FÓRMULA
    if (/^[=+\-@]/.test(t)) t = "'" + t;
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
      "Total (R$)", "Situação", "Minutos até lançar", "Observação", "Motivo do problema",
    ]];

    lista.forEach(function (p) {
      var gasto = minutosEntre(p.created_at, p.launched_at);
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

    // O "﻿" na frente é uma marca invisível que avisa o Excel de que o
    // arquivo está em UTF-8. Sem ela, "Porção" abre escrito "PorÃ§Ã£o" e o
    // dono acha que o sistema quebrou.
    var texto = "﻿" + linhas.map(function (l) {
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
    if (quiosquesViva) desenharQuiosques();
  });

  PL.ao("tique", function () {
    if (!telaViva) return;
    atualizarRelogios();
    // o botão de encerrar contas nasce sozinho quando dá a hora
    atualizarBotaoEncerrar();
  });

  // Quiosque novo, ou quiosque renomeado, muda o texto dos cartões.
  PL.ao("catalogo", function () {
    if (telaViva) desenharPedidos();
    if (histViva) desenharHistorico();
    if (quiosquesViva) desenharQuiosques();
  });

  // ==================================================================
  //  TELA "QUIOSQUES" — a conta aberta de cada um
  //  ------------------------------------------------------------------
  //  Cada quiosque tem uma CONTA: tudo o que foi pedido desde que o
  //  pescador chegou. Quando ele vai embora, a recepção abre a conta,
  //  confere item por item (dá para imprimir e entregar na mão) e fecha.
  //  Fechar zera: quem chegar depois começa do zero.
  //
  //  Isso não espera as 18h. Pescador que vai embora às duas da tarde
  //  tem a conta fechada às duas da tarde — a virada do turno é só o
  //  atalho para fechar várias de uma vez no fim do dia.
  // ==================================================================
  var caixaQuiosques = null;
  var quiosquesViva = false;

  function contaDoQuiosque(q) {
    var doTurno = PL.pedidosDaSessao(q);
    var valem = doTurno.filter(function (p) {
      return p.status !== "cancelado" && p.status !== "erro";
    });
    return {
      q: q,
      desde: PL.inicioDaSessao(q),
      pedidos: valem,
      cancelados: doTurno.length - valem.length,
      abertos: doTurno.filter(ehAberto).length,
      itens: valem.reduce(function (s, p) { return s + (Number(p.items_count) || 0); }, 0),
      total: valem.reduce(function (s, p) { return s + (Number(p.total_cents) || 0); }, 0),
    };
  }

  function montarQuiosques(caixa) {
    quiosquesViva = true;
    caixaQuiosques = caixa;

    caixa.innerHTML =
      '<section class="card">' +
        '<div class="card-head">' +
          '<h1 class="card-title">🏖️ Contas dos quiosques</h1>' +
          '<div class="filtros">' +
            '<button type="button" class="btn btn-sm btn-accent" id="qkEncerrar">🔄 Fechar várias</button>' +
          "</div>" +
        "</div>" +
        '<p class="hint">Toque num quiosque para ver a conta dele e fechar quando o pescador for embora.</p>' +
      "</section>" +
      '<div id="qkGrade"></div>';

    caixa.removeEventListener("click", cliqueNosQuiosques);
    caixa.addEventListener("click", cliqueNosQuiosques);
    PL.$("#qkEncerrar", caixa).addEventListener("click", abrirEncerrarContas);

    desenharQuiosques();
  }

  function cliqueNosQuiosques(ev) {
    var alvo = ev.target.closest("[data-quiosque]");
    if (!alvo) return;
    var q = ((PL.catalogo && PL.catalogo.quiosques) || [])
      .filter(function (x) { return x.id === alvo.getAttribute("data-quiosque"); })[0];
    if (q) abrirConta(q);
  }

  function desenharQuiosques() {
    if (!caixaQuiosques) return;
    var grade = PL.$("#qkGrade", caixaQuiosques);
    if (!grade) return;

    var lista = ((PL.catalogo && PL.catalogo.quiosques) || [])
      .filter(function (q) { return q.active !== false; })
      .slice()
      .sort(function (a, b) { return (Number(a.number) || 0) - (Number(b.number) || 0); })
      .map(contaDoQuiosque);

    if (!lista.length) {
      grade.innerHTML = '<div class="vazio"><b>Nenhum quiosque ativo.</b>Cadastre os quiosques na engrenagem.</div>';
      return;
    }

    grade.innerHTML = '<div class="quiosques-grade">' + lista.map(function (c) {
      var vazio = !c.pedidos.length;
      return '<button type="button" class="quiosque-card' +
          (vazio ? " vazio" : "") + (c.abertos ? " tem-aberto" : "") +
          '" data-quiosque="' + PL.esc(c.q.id) + '">' +
          '<div class="qk-topo">' +
            '<span class="qk-num">#' + PL.esc(c.q.number) + "</span>" +
            (c.abertos ? '<span class="qk-sino">🔔 ' + c.abertos + "</span>" : "") +
          "</div>" +
          '<div class="qk-nome">' + PL.esc(c.q.name) + "</div>" +
          '<div class="qk-total">' + (vazio ? "—" : PL.dinheiro(c.total)) + "</div>" +
          '<div class="qk-sub">' +
            (vazio
              ? "conta zerada"
              : c.pedidos.length + (c.pedidos.length === 1 ? " pedido" : " pedidos") +
                " · desde " + PL.esc(PL.hora(new Date(c.desde).toISOString()))) +
          "</div>" +
        "</button>";
    }).join("") + "</div>";
  }

  // ---- a conta, item por item ----
  function linhasDaConta(c) {
    if (!c.pedidos.length) return [];
    return c.pedidos.slice().sort(function (a, b) {
      return (a.daily_number || 0) - (b.daily_number || 0);
    });
  }

  function abrirConta(q) {
    var c = contaDoQuiosque(q);
    var pedidos = linhasDaConta(c);

    var corpo =
      '<div class="conta-topo">' +
        "<b>" + PL.esc(q.name) + "</b>" +
        "<span>conta aberta desde " + PL.esc(PL.hora(new Date(c.desde).toISOString())) + "</span>" +
      "</div>" +
      (pedidos.length
        ? '<div class="conta-lista">' + pedidos.map(function (p) {
            return '<div class="conta-pedido">' +
                '<div class="conta-cab">' +
                  "<b>Pedido #" + PL.esc(p.daily_number) + "</b>" +
                  "<span>" + PL.esc(PL.hora(p.created_at)) + " · " +
                    PL.esc(curtoStatus(p.status)) + "</span>" +
                "</div>" +
                (p.itens || []).map(function (i) {
                  return '<div class="conta-item">' +
                      "<span>" + PL.esc(i.qty) + "× " + PL.esc(i.product_name) + "</span>" +
                      "<span>" + PL.dinheiro(totalDoItem(i)) + "</span>" +
                    "</div>";
                }).join("") +
                '<div class="conta-sub"><span>subtotal</span><span>' +
                  PL.dinheiro(p.total_cents) + "</span></div>" +
              "</div>";
          }).join("") + "</div>" +
          '<div class="conta-total"><span>Total</span><span>' + PL.dinheiro(c.total) + "</span></div>" +
          (c.cancelados
            ? '<p class="hint" style="margin:8px 0 0">' + c.cancelados +
              (c.cancelados === 1 ? " pedido cancelado não entrou" : " pedidos cancelados não entraram") +
              " na conta.</p>"
            : "")
        : '<div class="vazio"><b>Conta zerada.</b>Nada foi pedido neste quiosque desde a última vez que a conta fechou.</div>') +
      (c.abertos
        ? '<div class="aviso aviso-warn" style="font-weight:400;font-size:.88rem;margin-top:12px"><div>' +
          "<b>" + c.abertos + (c.abertos === 1 ? " pedido ainda não foi lançado." : " pedidos ainda não foram lançados.") +
          "</b> Resolva antes de fechar, senão alguém pode estar esperando." +
          "</div></div>"
        : "");

    var botoes = [{ texto: "Voltar", classe: "btn-neutral" }];
    if (pedidos.length) {
      botoes.push({ texto: "🖨️ Imprimir", classe: "btn-outline",
        acao: function () { imprimirConta(c); } });
      botoes.push({ texto: "Fechar a conta", classe: "btn-accent",
        acao: function (fechar) { fecharConta(c, fechar); } });
    }

    PL.modal({ titulo: "🧾 Conta · " + q.name, larga: true, corpo: corpo, botoes: botoes });
  }

  async function fecharConta(c, fechar) {
    var certeza = await PL.confirmar({
      titulo: "Fechar a conta do " + c.q.name + "?",
      texto: "Total de <b>" + PL.dinheiro(c.total) + "</b> em " + c.pedidos.length +
        (c.pedidos.length === 1 ? " pedido." : " pedidos.") +
        "<br><br>A conta <b>zera</b>: quem chegar depois começa do zero. Os pedidos " +
        "continuam no histórico e no relatório do dia — nada é apagado." +
        (c.abertos ? "<br><br>⚠ Há <b>" + c.abertos + " pedido ainda não lançado</b>." : ""),
      ok: "Fechar a conta", perigo: !!c.abertos,
    });
    if (!certeza) return;

    try {
      await PL.backend.fecharSessoes([c.q.id]);
      await PL.recarregarCatalogo();
      await PL.recarregarPedidos();
      fechar();
      PL.aviso("Conta do " + c.q.name + " fechada. " + PL.dinheiro(c.total), "ok");
    } catch (e) {
      console.error("Fechar conta:", e);
      PL.aviso(PL.erroLegivel(e), "erro");
    }
  }

  // Folha para entregar na mão do pescador. Montada dentro da própria
  // página (tablet costuma bloquear pop-up) e só aparece na impressão.
  function imprimirConta(c) {
    var antiga = document.getElementById("folhaConta");
    if (antiga) antiga.remove();

    var casa = (PL.ctx && PL.ctx.cliente) || {};
    var folha = document.createElement("div");
    folha.id = "folhaConta";
    folha.className = "folha-conta";
    folha.innerHTML =
      '<div class="folha-conta-topo">' +
        "<b>" + PL.esc(casa.name || "Pedidos") + "</b>" +
        "<span>" + PL.esc(c.q.name) + " · " +
          PL.esc(new Date().toLocaleString("pt-BR")) + "</span>" +
      "</div>" +
      linhasDaConta(c).map(function (p) {
        return '<div class="folha-conta-pedido">' +
            "<b>Pedido #" + PL.esc(p.daily_number) + " · " + PL.esc(PL.hora(p.created_at)) + "</b>" +
            (p.itens || []).map(function (i) {
              return '<div class="folha-conta-item"><span>' + PL.esc(i.qty) + "× " +
                PL.esc(i.product_name) + "</span><span>" + PL.dinheiro(totalDoItem(i)) + "</span></div>";
            }).join("") +
          "</div>";
      }).join("") +
      '<div class="folha-conta-total"><span>TOTAL</span><span>' + PL.dinheiro(c.total) + "</span></div>";

    document.body.appendChild(folha);
    document.body.classList.add("imprimindo-conta");

    function limpar() {
      document.body.classList.remove("imprimindo-conta");
      var f = document.getElementById("folhaConta");
      if (f) f.remove();
      window.removeEventListener("afterprint", limpar);
    }
    window.addEventListener("afterprint", limpar);
    setTimeout(limpar, 60000);
    setTimeout(function () { window.print(); }, 120);
  }

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
      naTela = [];
      limparTemporizadores();

      // O selo do cabeçalho NÃO some ao sair desta aba — é justamente fora
      // dela que ele serve: o admin mexendo no cardápio precisa continuar
      // vendo que tem pedido esperando.
      if (PL.ehEquipe()) atualizarContadorDoTopo(contarAbertos().abertos);
      else limparContadorDoTopo();
    },

    // O ⚙ abre as configurações já na aba desta tela.
    engrenagem: function () {
      if (window.PLAdmin && typeof window.PLAdmin.abrir === "function") {
        window.PLAdmin.abrir("pedidos");
        return;
      }
      PL.aviso("As configurações ainda não carregaram.", "avisa");
    },
  });

  PL.registrarTela({
    id: "quiosques",
    rotulo: "Quiosques",
    icone: "🏖️",
    ordem: 10,
    papeis: ["recepcao", "admin"],

    montar: montarQuiosques,
    aoEntrar: function () { quiosquesViva = true; },
    aoSair: function () {
      quiosquesViva = false;
      if (caixaQuiosques) caixaQuiosques.removeEventListener("click", cliqueNosQuiosques);
      caixaQuiosques = null;
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
