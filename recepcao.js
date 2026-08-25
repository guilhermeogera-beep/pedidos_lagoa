/* ============================================================
   PEDIDOS LAGOA — RECEPÇÃO
   ============================================================
   As DUAS telas de quem fica no balcão:

     "Pedidos"   → o quadro ao vivo. É o coração do sistema.
     "Histórico" → a tabela do dia, com resumo e CSV (fechar caixa).

   O QUE MUDOU AO ENTRAR A COZINHA: o quadro não mostra mais
   "pedidos", e sim PARTES de pedido. Um pedido de porção + isca
   vira dois cartões:

     · a parte da COZINHA anda: recebido → cozinha → pronto → entregue
       (quem aperta "pronto" é a cozinha, não a recepção)
     · a parte do BALCÃO anda:  recebido → pronto → entregue
       (a recepção separa e já leva; não passa pela cozinha)

   Os dois cartões dizem "#12", com etiqueta de destino e um aviso
   de que existe outra metade — senão pareceria pedido duplicado.

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

  // Espera antes de dizer ao banco "eu vi esta parte". Marcar na hora
  // seria mentira: o cartão pode ter aparecido com a recepção de costas.
  var MS_ATE_MARCAR_VISTO = 4000;

  // ------------------------------------------------------------------
  //  ESTADO DESTE ARQUIVO
  // ------------------------------------------------------------------
  var filtros = {
    quiosque: "",        // "" = todos
    status: "abertos",   // "abertos" | "todos" | um status
    destino: "",         // "" = todos | "cozinha" | "balcao"
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
  var novas = {};              // id da parte -> hora em que ela apareceu
  var jaAvisados = {};         // partes já mandadas para o "marcar visto"
  var naTela = [];             // as partes desenhadas neste momento

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

  // A parte traz o pedido junto (PL.achatarPartes). Mesmo assim o quiosque
  // pode faltar numa conexão ruim — e a recepção NUNCA pode ficar sem saber
  // de quem é o pedido.
  function nomeDoQuiosque(t) {
    var p = t.pedido || {};
    if (p.quiosque && (p.quiosque.name || p.quiosque.number)) {
      return p.quiosque.name || ("Quiosque " + p.quiosque.number);
    }
    var lista = (PL.catalogo && PL.catalogo.quiosques) || [];
    for (var i = 0; i < lista.length; i++) {
      if (lista[i].id === t.kiosk_id) return lista[i].name || ("Quiosque " + lista[i].number);
    }
    return "Quiosque ?";
  }

  // O semáforo conta desde que o QUIOSQUE pediu — é o tempo que o cliente
  // sente. (A cozinha tem outro relógio, contando de quando ela recebeu.)
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

  function ehAberto(t) { return PL.ABERTOS.indexOf(t.status) >= 0; }

  function minutosEntre(inicio, fim) {
    if (!inicio || !fim) return null;
    var d = (new Date(fim).getTime() - new Date(inicio).getTime()) / 60000;
    if (isNaN(d)) return null;
    return Math.max(0, Math.round(d));
  }

  function quantosItens(t) {
    if (t.items_count) return Number(t.items_count);
    return (t.itens || []).reduce(function (s, it) { return s + (Number(it.qty) || 0); }, 0);
  }

  function totalDoItem(it) {
    if (it.line_total_cents !== null && it.line_total_cents !== undefined) return it.line_total_cents;
    return (Number(it.unit_price_cents) || 0) * (Number(it.qty) || 1);
  }

  function rotuloStatus(s) { return (PL.STATUS[s] && PL.STATUS[s].rotulo) || s || "?"; }
  function curtoStatus(s)  { return (PL.STATUS[s] && PL.STATUS[s].curto)  || s || "?"; }
  function iconeStatus(s)  { return (PL.STATUS[s] && PL.STATUS[s].icone)  || ""; }

  function somLigado() { return PL.CFG.somPedidoNovo !== false && filtros.som !== false; }

  function ehNova(t) { return !!novas[t.id] && (Date.now() - novas[t.id]) < MS_DESTAQUE_NOVO; }

  function guardarTemporizador(t) { temporizadores.push(t); return t; }

  function limparTemporizadores() {
    temporizadores.forEach(function (t) { clearTimeout(t); clearInterval(t); });
    temporizadores = [];
    vistoTimer = null;
    chegadaTimer = null;
  }

  // ==================================================================
  //  O CARTÃO DE UMA PARTE
  // ==================================================================
  function botao(classe, texto, atributos) {
    return '<button type="button" class="btn ' + classe + '" ' + (atributos || "") + ">" +
      PL.esc(texto) + "</button>";
  }

  // Os botões saem do DESTINO da parte, não de um "se for pesca" espalhado
  // pela tela. Quem sabe qual é o próximo passo é o núcleo (PL.proximoStatus),
  // que segue a mesma regra que o banco cobra.
  function acoesDaParte(t, compacto) {
    var tam = compacto ? " btn-sm" : "";
    var cozinha = t.destination === "cozinha";

    if (!ehAberto(t)) {
      // entregue / erro / cancelado: só a saída de emergência
      return botao("btn-neutral btn-sm", "↺ Reabrir", 'data-ir="recebido" data-confirmar="1"');
    }

    if (t.status === "recebido") {
      return (cozinha
        ? botao("btn-info" + tam, "👨‍🍳 Passei p/ cozinha", 'data-ir="cozinha"')
        // no balcão a recepção separa e o item já pode ir para o quiosque
        : botao("btn-ok" + tam, "🎣 Separei", 'data-ir="pronto"')) +
        botao("btn-danger" + tam, "⚠ Pediu errado", 'data-erro="1"');
    }

    if (t.status === "cozinha") {
      // Quem marca pronto é a COZINHA. O botão aqui é a saída para quando
      // o tablet da cozinha estiver sem bateria — por isso ele é pequeno e
      // vem depois, não na frente.
      return '<span class="hint" style="flex:1 1 100%">Esperando a cozinha marcar como pronto.</span>' +
        botao("btn-neutral btn-sm", "↩ Voltar", 'data-ir="recebido"') +
        botao("btn-ok btn-sm", "✅ Pronto (pela cozinha)", 'data-ir="pronto"') +
        botao("btn-danger btn-sm", "⚠ Pediu errado", 'data-erro="1"');
    }

    if (t.status === "pronto") {
      return botao("btn-primary" + tam, "📦 Entregue", 'data-ir="entregue"') +
        botao("btn-neutral" + tam, "↩ Voltar", 'data-ir="' + (cozinha ? "cozinha" : "recebido") + '"');
    }

    return "";
  }

  function linhaDoItem(it) {
    var obs = it.notes ? '<span class="pi-obs">↳ ' + PL.esc(it.notes) + "</span>" : "";
    return '<div class="pi">' +
        '<span class="pi-qtd">' + PL.esc(it.qty) + "×</span>" +
        '<span class="pi-nome">' + PL.esc(it.product_name) + obs + "</span>" +
        '<span class="pi-valor">' + PL.dinheiro(totalDoItem(it)) + "</span>" +
      "</div>";
  }

  function metasDaParte(t) {
    var p = t.pedido || {};
    var partes = [];
    if (p.customer_name) partes.push('<span class="meta">👤 ' + PL.esc(p.customer_name) + "</span>");
    if (p.table_label)   partes.push('<span class="meta">📍 ' + PL.esc(p.table_label) + "</span>");
    var n = quantosItens(t);
    partes.push('<span class="meta">' + n + (n === 1 ? " item" : " itens") + "</span>");
    if (p.notes)        partes.push('<span class="meta obs">📝 ' + PL.esc(p.notes) + "</span>");
    if (t.error_reason) partes.push('<span class="meta erro">⚠ ' + PL.esc(t.error_reason) + "</span>");
    return '<div class="pedido-meta">' + partes.join("") + "</div>";
  }

  // Um pedido dividido gera dois cartões com o mesmo número. Sem este
  // lembrete, a recepção entregaria a comida achando que acabou — e a
  // isca ficaria para trás no balcão.
  function avisoDaOutraMetade(t) {
    var irmas = ((t.pedido || {}).partes || []).filter(function (x) { return x.id !== t.id; });
    if (!irmas.length) return "";
    return '<div class="tem-irma">🔗 Este pedido tem outra parte: ' +
      irmas.map(function (x) {
        var d = PL.destinoDe(x.destination);
        return "<b>" + PL.esc(d.rotulo) + "</b> (" + PL.esc(curtoStatus(x.status)) + ")";
      }).join(" · ") + "</div>";
  }

  // opcoes.compacto → cartão do "Fechados hoje" (sem a lista de itens)
  function cartaoDaParte(t, opcoes) {
    var o = opcoes || {};
    var p = t.pedido || {};
    var aberto = ehAberto(t);
    var min = PL.minutosDesde(p.created_at || t.created_at);
    var grau = aberto ? grauDoTempo(min) : "";
    var itens = t.itens || [];
    var dest = PL.destinoDe(t.destination);

    var canto;
    if (aberto) {
      canto = '<span class="pedido-tempo' + (grau ? " " + grau : "") + '">' +
                PL.esc(PL.tempoCurto(min)) + "</span>";
    } else {
      // Só a parte ENTREGUE mostra quanto demorou. Em "pediu errado" esse
      // número não quer dizer nada — e "ERRADO · agora" parece que algo
      // acabou de dar errado neste instante.
      var gasto = minutosEntre(p.created_at || t.created_at, t.delivered_at);
      canto = '<span class="status-chip status-' + PL.esc(t.status) + '">' +
                PL.esc(curtoStatus(t.status)) +
                (gasto === null ? "" : " · " + PL.esc(PL.tempoCurto(gasto))) +
              "</span>";
    }

    var corpoItens = o.compacto
      ? ""
      : '<div class="pedido-itens">' + (itens.length
          ? itens.map(linhaDoItem).join("")
          : '<div class="hint">Esta parte chegou sem itens — confira com o quiosque.</div>') + "</div>";

    var verItens = o.compacto
      ? botao("btn-neutral btn-sm", "👁 Ver itens", 'data-detalhe="1"')
      : "";

    var classes = "pedido" +
      (ehNova(t) ? " novo" : "") +
      (aberto && grau === "atrasado" ? " atrasado" : "");

    return '<article class="' + classes + '" data-status="' + PL.esc(t.status) + '"' +
             ' data-destino="' + PL.esc(t.destination) + '"' +
             ' data-parte="' + PL.esc(t.id) + '">' +
        '<div class="pedido-topo">' +
          '<div class="pedido-quiosque">' +
            "<b>" + PL.esc(nomeDoQuiosque(t)) + "</b>" +
            '<span class="pedido-num">Pedido #' + PL.esc(p.daily_number) +
              " · " + PL.esc(PL.hora(p.created_at || t.created_at)) + "</span>" +
          "</div>" +
          '<div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">' +
            '<span class="destino-chip destino-' + PL.esc(t.destination) + '">' +
              dest.icone + " " + PL.esc(dest.rotulo) + "</span>" +
            canto +
          "</div>" +
        "</div>" +
        corpoItens +
        metasDaParte(t) +
        avisoDaOutraMetade(t) +
        '<div class="pedido-rodape">' +
          '<span class="pedido-total">' + PL.dinheiro(t.total_cents) + "</span>" +
          '<div class="pedido-acoes">' + verItens + acoesDaParte(t, !!o.compacto) + "</div>" +
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

  function opcoesDeDestino(escolhido) {
    var html = '<option value="">Cozinha e balcão</option>';
    Object.keys(PL.DESTINOS).forEach(function (d) {
      var x = PL.DESTINOS[d];
      html += '<option value="' + PL.esc(d) + '"' + (d === escolhido ? " selected" : "") + ">" +
        x.icone + " Só " + PL.esc(x.rotulo.toLowerCase()) + "</option>";
    });
    return html;
  }

  function statusEscolhidos() {
    if (filtros.status === "todos") return Object.keys(PL.STATUS);
    if (filtros.status === "abertos") return PL.ABERTOS.slice();
    return [filtros.status];
  }

  function passaNoFiltro(t) {
    if (filtros.quiosque && t.kiosk_id !== filtros.quiosque) return false;
    if (filtros.destino && t.destination !== filtros.destino) return false;
    return true;
  }

  function montarPedidos(caixa) {
    telaViva = true;
    caixaPedidos = caixa;
    lerFiltros();

    var switchSom = PL.CFG.somPedidoNovo === false ? "" :
      '<label class="switch" title="Toca quando chega pedido e quando a cozinha marca pronto">' +
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
            '<select id="pdDestino" aria-label="Filtrar por destino">' +
              opcoesDeDestino(filtros.destino) + "</select>" +
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
    // vezes acaba mandando a mesma parte para a cozinha três vezes.
    caixa.removeEventListener("click", cliqueNaTela);
    caixa.addEventListener("click", cliqueNaTela);

    PL.$("#pdQuiosque", caixa).addEventListener("change", function () {
      filtros.quiosque = this.value; gravarFiltros(); desenharPedidos();
    });
    PL.$("#pdDestino", caixa).addEventListener("change", function () {
      filtros.destino = this.value; gravarFiltros(); desenharPedidos();
    });
    PL.$("#pdStatus", caixa).addEventListener("change", function () {
      filtros.status = this.value; gravarFiltros(); desenharPedidos();
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

    desenharPedidos();
  }

  function desenharPedidos() {
    if (!caixaPedidos) return;

    var todas = PL.partes;
    var filtradas = todas.filter(passaNoFiltro);
    var escolhidos = statusEscolhidos();
    var abertosEscolhidos = escolhidos.filter(function (s) { return PL.ABERTOS.indexOf(s) >= 0; });
    var fechadosEscolhidos = escolhidos.filter(function (s) { return PL.FECHADOS.indexOf(s) >= 0; });

    var quadro = PL.$("#pdQuadro", caixaPedidos);
    var caixaFechados = PL.$("#pdFechados", caixaPedidos);
    naTela = [];

    if (!todas.length) {
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
      var emAberto = filtradas
        .filter(function (t) { return abertosEscolhidos.indexOf(t.status) >= 0; })
        .slice()
        // a mais antiga em cima: quem espera há mais tempo é a próxima
        .sort(ordemDeTrabalho);
      naTela = naTela.concat(emAberto);

      if (PL.CFG.colunasStatus !== false && abertosEscolhidos.length > 1) {
        quadro.innerHTML = desenharColunas(emAberto);
      } else {
        quadro.innerHTML = desenharListaUnica(emAberto);
      }

      // O filtro de cima manda no quadro, não aqui: escolher "Na cozinha"
      // não pode fazer o fechamento do dia sumir da vista.
      var fechadas = filtradas
        .filter(function (t) { return !ehAberto(t); })
        .slice()
        .sort(function (a, b) {
          return new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at);
        });

      var limite = Number(PL.CFG.mostrarEntreguesHoje);
      if (!(limite > 0)) limite = 20;
      var mostrar = fechadas.slice(0, limite);
      naTela = naTela.concat(mostrar);

      caixaFechados.hidden = false;
      caixaFechados.innerHTML =
        '<div class="card-head">' +
          '<h2 class="card-title">📦 Fechados hoje</h2>' +
          '<span class="hint">' + fechadas.length +
            (fechadas.length === 1 ? " parte encerrada" : " partes encerradas") +
            (fechadas.length > mostrar.length ? " · mostrando as " + mostrar.length + " últimas" : "") +
          "</span>" +
        "</div>" +
        (mostrar.length
          ? '<div class="coluna-lista">' +
              mostrar.map(function (t) { return cartaoDaParte(t, { compacto: true }); }).join("") +
            "</div>"
          : '<div class="hint">Nada encerrado ainda. Assim que uma parte for entregue, ela desce para cá.</div>');
    } else {
      // O filtro pediu SÓ situações encerradas: o quadro vira a lista delas
      // e o card de fechados sairia repetido — some.
      var soFechadas = filtradas
        .filter(function (t) { return fechadosEscolhidos.indexOf(t.status) >= 0; })
        .slice()
        .sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
      naTela = soFechadas.slice();
      quadro.innerHTML = desenharListaUnica(soFechadas);
      caixaFechados.hidden = true;
    }

    atualizarResumo();
    agendarVistos();
  }

  // O que espera há mais tempo vem primeiro. O horário que vale é o do
  // PEDIDO (quando o quiosque pediu), não o da parte: é o tempo que o
  // cliente sente.
  function ordemDeTrabalho(a, b) {
    var da = new Date((a.pedido && a.pedido.created_at) || a.created_at);
    var db = new Date((b.pedido && b.pedido.created_at) || b.created_at);
    return da - db;
  }

  // Três colunas: é o desenho que a recepção entende sem treinamento — o
  // cartão anda da esquerda para a direita até sair. A coluna do meio só
  // tem comida: o que é do balcão pula direto de "recebido" para "pronto".
  function desenharColunas(lista) {
    var explica = {
      recebido: "Confira e libere",
      cozinha:  "Com a cozinha",
      pronto:   "Leve ao quiosque",
    };
    return '<div class="quadro">' + PL.ABERTOS.map(function (s) {
      var doStatus = lista
        .filter(function (t) { return t.status === s; })
        .slice()
        .sort(ordemDeTrabalho);

      return '<section class="coluna" data-status="' + PL.esc(s) + '">' +
          '<div class="coluna-head">' +
            "<h2>" + iconeStatus(s) + " " + PL.esc(rotuloStatus(s)) + "</h2>" +
            '<span class="n">' + doStatus.length + "</span>" +
          "</div>" +
          '<p class="hint" style="margin:-6px 4px 10px;font-size:.78rem">' + explica[s] + "</p>" +
          '<div class="coluna-lista">' +
            (doStatus.length
              ? doStatus.map(function (t) { return cartaoDaParte(t, {}); }).join("")
              : '<p class="hint" style="text-align:center;padding:12px 4px;margin:0">Nada aqui.</p>') +
          "</div>" +
        "</section>";
    }).join("") + "</div>";
  }

  function desenharListaUnica(lista) {
    if (!lista.length) {
      return '<div class="vazio">' +
        "<b>Nenhum pedido com esse filtro.</b>" +
        "Volte o filtro para <b>Em aberto</b> para ver o movimento do momento." +
      "</div>";
    }
    return '<div class="coluna-lista">' +
      lista.map(function (t) { return cartaoDaParte(t, {}); }).join("") +
      "</div>";
  }

  // ==================================================================
  //  CONTADORES
  //  Contam SEMPRE o dia inteiro, sem olhar o filtro: uma parte atrasada
  //  escondida por um filtro seria o pior defeito possível nesta tela.
  // ==================================================================
  function contarAbertos() {
    var abertas = PL.partes.filter(ehAberto);
    var atrasadas = abertas.filter(function (t) {
      return PL.minutosDesde((t.pedido && t.pedido.created_at) || t.created_at) >= slaAtrasado();
    });
    var prontas = abertas.filter(function (t) { return t.status === "pronto"; });
    return { abertas: abertas.length, atrasadas: atrasadas.length, prontas: prontas.length };
  }

  function atualizarResumo() {
    var c = contarAbertos();

    var linha = PL.$("#pdResumo", caixaPedidos || document);
    if (linha) {
      var txt = c.abertas
        ? c.abertas + (c.abertas === 1 ? " parte em aberto" : " partes em aberto")
        : "Tudo em dia — nada em aberto.";
      if (c.prontas) {
        txt += " · ✅ " + c.prontas + (c.prontas === 1 ? " pronta para levar" : " prontas para levar");
      }
      if (c.atrasadas) {
        txt += " · ⚠ " + c.atrasadas +
          (c.atrasadas === 1 ? " passou" : " passaram") + " de " + slaAtrasado() + " min";
      }
      linha.textContent = txt;
    }

    atualizarContadorDoTopo(c);
  }

  // O selo do cabeçalho acompanha a recepção mesmo em outra aba do app —
  // por isso ele vive fora desta tela. Quando tem coisa PRONTA esperando,
  // ele mostra isso: é a informação que faz alguém levantar do banquinho.
  function atualizarContadorDoTopo(c) {
    var el = PL.$("#contadorTopo");
    if (!el) return;
    if (!c || !c.abertas) {
      el.className = "contador zero";
      el.textContent = "";
      el.hidden = true;
      return;
    }
    el.className = "contador";
    el.hidden = false;
    el.innerHTML = c.prontas
      ? "<b>" + c.prontas + "</b> pronto p/ levar"
      : "<b>" + c.abertas + "</b> em aberto";
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
    var porId = {};
    PL.partes.forEach(function (t) { porId[t.id] = t; });

    PL.$$(".pedido[data-parte]", caixaPedidos).forEach(function (el) {
      var t = porId[el.dataset.parte];
      if (!t || !ehAberto(t)) return;
      var min = PL.minutosDesde((t.pedido && t.pedido.created_at) || t.created_at);
      var grau = grauDoTempo(min);
      var campo = PL.$(".pedido-tempo", el);
      if (campo) {
        campo.textContent = PL.tempoCurto(min);
        campo.className = "pedido-tempo" + (grau ? " " + grau : "");
      }
      el.classList.toggle("atrasado", grau === "atrasado");
      if (el.classList.contains("novo") && !novas[el.dataset.parte]) el.classList.remove("novo");
    });
    atualizarResumo();
  }

  // ==================================================================
  //  AVISOS
  //  Dois momentos merecem som: chegou pedido, e a COZINHA TERMINOU.
  //  O segundo é o motivo de a cozinha existir no sistema — sem ele a
  //  recepção continuaria indo até a janela perguntar "já saiu?".
  // ==================================================================
  function avisarChegada(partes) {
    var agora = Date.now();
    partes.forEach(function (t) { novas[t.id] = agora; });

    if (somLigado()) PL.tocarAviso(3);
    PL.vibrar([200, 80, 200]);

    PL.aviso(partes.length === 1
      ? "🔔 Pedido novo do " + nomeDoQuiosque(partes[0])
      : "🔔 " + partes.length + " pedidos novos", "avisa");

    programarLimpezaDoDestaque();
  }

  function avisarProntoDaCozinha(partes) {
    var agora = Date.now();
    partes.forEach(function (t) { novas[t.id] = agora; });

    if (somLigado()) PL.tocarAviso(4);
    PL.vibrar([120, 60, 120, 60, 260]);

    PL.aviso(partes.length === 1
      ? "✅ Cozinha terminou: #" + ((partes[0].pedido || {}).daily_number || "") +
        " do " + nomeDoQuiosque(partes[0])
      : "✅ A cozinha terminou " + partes.length + " comandas", "ok");

    programarLimpezaDoDestaque();
  }

  function programarLimpezaDoDestaque() {
    clearTimeout(chegadaTimer);
    chegadaTimer = guardarTemporizador(setTimeout(function () {
      Object.keys(novas).forEach(function (id) {
        if (Date.now() - novas[id] >= MS_DESTAQUE_NOVO) delete novas[id];
      });
      if (telaViva) desenharPedidos();
    }, MS_DESTAQUE_NOVO + 200));
  }

  // "Visto" só vale se alguém estava mesmo olhando: daí o atraso e a
  // conferência de que a tela está aberta e na frente.
  function agendarVistos() {
    clearTimeout(vistoTimer);
    vistoTimer = guardarTemporizador(setTimeout(function () {
      if (!telaViva || document.visibilityState !== "visible") return;
      var ids = naTela
        .filter(function (t) { return !t.ack_at && !jaAvisados[t.id]; })
        .map(function (t) { return t.id; });
      if (!ids.length) return;

      ids.forEach(function (id) { jaAvisados[id] = true; });
      Promise.resolve(PL.backend.marcarVistos(ids)).catch(function (e) {
        // deu errado? esquece a marca para tentar de novo no próximo desenho
        ids.forEach(function (id) { delete jaAvisados[id]; });
        console.warn("Marcar como visto:", e);
      });
    }, MS_ATE_MARCAR_VISTO));
  }

  // Repetir o aviso enquanto houver coisa esquecida é opcional (repetirSom).
  function ligarRepeticaoDoSom() {
    var seg = Number(PL.CFG.repetirSom) || 0;
    if (seg <= 0) return;
    guardarTemporizador(setInterval(function () {
      if (!telaViva || !somLigado()) return;
      if (document.visibilityState !== "visible") return;
      var esquecidas = PL.partes.filter(function (t) {
        // pedido não visto OU comida pronta parada esperando alguém levar
        return (t.status === "recebido" && !t.ack_at) || t.status === "pronto";
      });
      if (esquecidas.length) PL.tocarAviso(2);
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

  function partePorId(id) {
    var lista = PL.partes;
    for (var i = 0; i < lista.length; i++) if (lista[i].id === id) return lista[i];
    return null;
  }

  function cliqueNaTela(ev) {
    var alvo = ev.target.closest("[data-ir], [data-erro], [data-detalhe]");
    if (!alvo) return;
    var cartao = alvo.closest(".pedido");
    if (!cartao) return;
    var t = partePorId(cartao.dataset.parte);
    if (!t) return;

    if (alvo.hasAttribute("data-detalhe")) { verItens(t); return; }
    if (alvo.hasAttribute("data-erro"))    { abrirMotivo(t, cartao); return; }

    var destino = alvo.dataset.ir;
    if (!destino) return;

    if (alvo.hasAttribute("data-confirmar")) {
      PL.confirmar({
        titulo: "Reabrir esta parte do pedido #" + ((t.pedido || {}).daily_number || "") + "?",
        texto: "Ela volta para <b>Recebido</b>, como se tivesse acabado de chegar. Use quando foi fechada por engano.",
        ok: "Reabrir",
      }).then(function (sim) {
        if (sim) aplicarStatus(t, destino, null, cartao);
      });
      return;
    }

    aplicarStatus(t, destino, null, cartao);
  }

  // Trava o cartão inteiro enquanto o banco não responde: com dois toques
  // rápidos a parte pularia uma etapa e a cozinha ficaria sem aviso.
  function aplicarStatus(t, status, motivo, cartao) {
    travarCartao(cartao);
    var num = (t.pedido || {}).daily_number || "";
    return Promise.resolve(PL.backend.mudarStatusParte(t.id, status, motivo))
      .then(function () { return PL.recarregarPedidos(); })
      .then(function () {
        PL.aviso("Pedido #" + num + " (" + PL.destinoDe(t.destination).rotulo.toLowerCase() + "): " +
          rotuloStatus(status).toLowerCase() + ".", "ok");
      })
      .catch(function (e) {
        destravarCartao(cartao);
        PL.aviso(PL.erroLegivel(e), "erro");
      });
  }

  // O cartão compacto esconde os itens; este pop-up mostra a parte inteira
  // sem tirar a recepção da tela.
  function verItens(t) {
    var itens = t.itens || [];
    var p = t.pedido || {};
    var dest = PL.destinoDe(t.destination);
    PL.modal({
      titulo: "Pedido #" + (p.daily_number || "") + " · " + dest.rotulo + " · " + nomeDoQuiosque(t),
      corpo:
        '<div class="pedido-itens">' +
          (itens.length ? itens.map(linhaDoItem).join("")
                        : '<div class="hint">Esta parte não tem itens registrados.</div>') +
        "</div>" +
        metasDaParte(t) +
        avisoDaOutraMetade(t) +
        '<div class="pedido-rodape">' +
          '<span class="pedido-total">' + PL.dinheiro(t.total_cents) + "</span>" +
          '<span class="status-chip status-' + PL.esc(t.status) + '">' +
            PL.esc(rotuloStatus(t.status)) + "</span>" +
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
  function abrirMotivo(t, cartao) {
    var prontos = Array.isArray(PL.CFG.motivosErro) ? PL.CFG.motivosErro : [];
    var escolhido = "";
    var p = t.pedido || {};
    var dest = PL.destinoDe(t.destination);
    var temIrma = ((p.partes || []).length > 1);

    var html =
      '<p class="hint" style="margin:0">Parte <b>' + PL.esc(dest.rotulo) + "</b> do pedido <b>#" +
        PL.esc(p.daily_number) + "</b> do <b>" + PL.esc(nomeDoQuiosque(t)) + "</b> — " +
        PL.dinheiro(t.total_cents) + ".</p>" +
      (temIrma
        ? '<div class="aviso aviso-warn" style="font-weight:400;font-size:.88rem"><div>' +
          "Só <b>esta parte</b> será encerrada. A outra metade do pedido continua andando normalmente." +
          "</div></div>"
        : "") +
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
        "<b>Pediu errado</b> é quando já houve gasto — a cozinha começou, ou a isca foi aberta. " +
        "<b>Cancelar</b> é quando <b>nada</b> foi feito ainda, então não houve prejuízo." +
      "</p>";

    PL.modal({
      titulo: "⚠ Deu problema nesta parte",
      corpo: html,
      botoes: [
        { texto: "Voltar", classe: "btn-neutral" },
        { texto: "Cancelar a parte", classe: "btn-neutral", id: "mtCancelar",
          acao: function (fechar) {
            if (!escolhido) return;
            fechar();
            aplicarStatus(t, "cancelado", escolhido, cartao);
          } },
        { texto: "Pediu errado", classe: "btn-danger", id: "mtErro",
          acao: function (fechar) {
            if (!escolhido) return;
            fechar();
            aplicarStatus(t, "erro", escolhido, cartao);
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
          var t2 = livre.value.trim();
          if (t2) {
            PL.$$(".motivo", corpo).forEach(function (x) { x.classList.remove("is-sel"); });
            escolhido = t2;
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
  //  Aqui a linha é o PEDIDO (e não a parte): quem confere caixa pensa
  //  em venda, não em comanda. As partes aparecem numa coluna própria.
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

  function nomeDoQuiosquePedido(p) {
    if (p.quiosque && (p.quiosque.name || p.quiosque.number)) {
      return p.quiosque.name || ("Quiosque " + p.quiosque.number);
    }
    var lista = (PL.catalogo && PL.catalogo.quiosques) || [];
    for (var i = 0; i < lista.length; i++) {
      if (lista[i].id === p.kiosk_id) return lista[i].name || ("Quiosque " + lista[i].number);
    }
    return "Quiosque ?";
  }

  // Quando o pedido terminou de verdade = quando a ÚLTIMA parte saiu.
  function entregueEm(p) {
    var partes = p.partes || [];
    if (!partes.length) return null;
    if (partes.some(function (t) { return !t.delivered_at; })) return null;
    return partes.map(function (t) { return t.delivered_at; }).sort().pop();
  }

  function resumoDasPartes(p) {
    return (p.partes || []).map(function (t) {
      return PL.destinoDe(t.destination).rotulo + ": " + curtoStatus(t.status);
    }).join(" · ") || "—";
  }

  function desenharResumoDoDia(lista) {
    var el = PL.$("#hsResumo", caixaHist || document);
    if (!el) return;

    var faturado = lista
      .filter(function (p) { return p.status !== "erro" && p.status !== "cancelado"; })
      .reduce(function (s, p) { return s + (Number(p.total_cents) || 0); }, 0);

    var tempos = lista
      .map(function (p) { return minutosEntre(p.created_at, entregueEm(p)); })
      .filter(function (m) { return m !== null; });
    var media = tempos.length
      ? Math.round(tempos.reduce(function (s, m) { return s + m; }, 0) / tempos.length)
      : null;

    var errados = lista.filter(function (p) {
      return p.status === "erro" || p.status === "cancelado";
    }).length;

    var divididos = lista.filter(function (p) { return (p.partes || []).length > 1; }).length;

    el.innerHTML =
      '<span class="meta"><b>' + lista.length + "</b> " +
        (lista.length === 1 ? "pedido" : "pedidos") + "</span>" +
      '<span class="meta"><b>' + PL.dinheiro(faturado) + "</b> em pedidos válidos</span>" +
      '<span class="meta">entrega em média ' +
        (media === null ? "—" : "<b>" + PL.esc(PL.tempoCurto(media)) + "</b>") + "</span>" +
      (divididos ? '<span class="meta">' + divididos + " dividido(s) em duas partes</span>" : "") +
      (errados
        ? '<span class="meta erro">' + errados +
          (errados === 1 ? " deu errado" : " deram errado") + "</span>"
        : '<span class="meta">nenhum deu errado</span>');
  }

  function resumoDosItens(p) {
    var itens = [];
    (p.partes || []).forEach(function (t) { itens = itens.concat(t.itens || []); });
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
      var gasto = minutosEntre(p.created_at, entregueEm(p));
      var resumo = resumoDosItens(p);
      return "<tr>" +
        "<td><b>#" + PL.esc(p.daily_number) + "</b></td>" +
        "<td>" + PL.esc(PL.hora(p.created_at)) + "</td>" +
        "<td>" + PL.esc(nomeDoQuiosquePedido(p)) + "</td>" +
        '<td title="' + PL.esc(resumo) + '">' + PL.esc(resumo) + "</td>" +
        "<td>" + PL.esc(resumoDasPartes(p)) + "</td>" +
        '<td class="num">' + PL.dinheiro(p.total_cents) + "</td>" +
        '<td><span class="status-chip status-' + PL.esc(p.status) + '">' +
          PL.esc(curtoStatus(p.status)) + "</span></td>" +
        '<td class="num">' + (gasto === null ? "—" : PL.esc(PL.tempoCurto(gasto))) + "</td>" +
      "</tr>";
    }).join("");

    alvo.innerHTML =
      '<table class="tabela">' +
        "<thead><tr>" +
          "<th>Nº</th><th>Hora</th><th>Quiosque</th><th>Itens</th><th>Partes</th>" +
          '<th class="num">Total</th><th>Situação</th><th class="num">Até entregar</th>' +
        "</tr></thead>" +
        "<tbody>" + linhas + "</tbody>" +
      "</table>";
  }

  // ==================================================================
  //  EXPORTAR CSV
  //  Feito à mão, sem biblioteca: funciona no tablet mesmo com a internet
  //  oscilando, porque o arquivo nasce dentro do navegador.
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
      "Nº", "Hora", "Quiosque", "Cliente", "Lugar", "Itens", "Qtd. itens", "Partes",
      "Total (R$)", "Situação", "Minutos até entregar", "Observação", "Motivo do erro",
    ]];

    lista.forEach(function (p) {
      var gasto = minutosEntre(p.created_at, entregueEm(p));
      var motivos = (p.partes || [])
        .map(function (t) { return t.error_reason; })
        .filter(Boolean).join(" | ");
      linhas.push([
        p.daily_number,
        PL.hora(p.created_at),
        nomeDoQuiosquePedido(p),
        p.customer_name || "",
        p.table_label || "",
        resumoDosItens(p),
        p.items_count || 0,
        resumoDasPartes(p),
        dinheiroCsv(p.total_cents),
        rotuloStatus(p.status),
        gasto === null ? "" : gasto,
        p.notes || "",
        motivos,
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
  //  Ficam fora das telas de propósito: o som tem que tocar mesmo se a
  //  recepção estiver na aba do histórico ou mexendo no cardápio.
  // ==================================================================
  PL.ao("pedidos", function (dados) {
    if (PL.ehEquipe()) {
      var novasPartes = ((dados && dados.novas) || []).filter(function (t) {
        return t.status === "recebido";
      });
      if (novasPartes.length) avisarChegada(novasPartes);

      // A cozinha terminou: é ESTE aviso que faz a recepção levantar.
      var prontas = ((dados && dados.mudaram) || [])
        .filter(function (m) {
          return m.para === "pronto" && m.parte.destination === "cozinha" && m.de === "cozinha";
        })
        .map(function (m) { return m.parte; });
      if (prontas.length) avisarProntoDaCozinha(prontas);
    }

    if (telaViva) desenharPedidos();
    else if (PL.ehEquipe()) atualizarContadorDoTopo(contarAbertos());
    if (histViva) desenharHistorico();
  });

  PL.ao("tique", function () {
    if (telaViva) atualizarRelogios();
  });

  // Quiosque novo, ou renomeado, muda o texto dos cartões.
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
      naTela = [];
      limparTemporizadores();

      // O selo do cabeçalho NÃO some ao sair desta aba — é justamente fora
      // dela que ele serve: o admin mexendo no cardápio precisa continuar
      // vendo que tem pedido esperando.
      if (PL.ehEquipe()) atualizarContadorDoTopo(contarAbertos());
      else limparContadorDoTopo();
    },

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
