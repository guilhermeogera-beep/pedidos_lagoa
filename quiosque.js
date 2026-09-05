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
  var popCarrinho = null;       // o pop-up de conferência, quando está aberto

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
  var assinaturaRelogio = null;  // o mesmo, para a virada do cardápio noturno
  // Qual seção está desenhada AGORA. Diferente de abaAtual: o normal é a
  // pessoa nunca tocar numa aba, e aí abaAtual fica vazio a manhã inteira.
  var secaoMostrada = null;

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
  //
  // O admin enxerga também as abas fora do horário (marcadas com o
  // relógio), pelo mesmo motivo que ele enxerga produto desligado: é assim
  // que ele confere às 10h da manhã se o cardápio noturno está certo, sem
  // ter que voltar à lagoa de madrugada.
  function secoesVisiveis() {
    var admin = PL.ehAdmin();
    return (PL.catalogo.secoes || [])
      .filter(function (s) {
        if (s.active === false) return false;
        return admin || secaoNoAr(s);
      })
      .sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
  }

  function secaoAtual() {
    var lista = secoesVisiveis();
    if (!lista.length) return null;
    var achada = lista.filter(function (s) { return s.id === abaAtual; })[0];
    if (achada) return achada;

    // A aba que estava na tela saiu do ar. Se foi outra que tomou o lugar
    // dela, é NESSA que a pessoa deve cair: às 18h em ponto quem está no
    // quiosque olhando o cardápio de comida quer ver o da noite, não a aba
    // de iscas que por acaso vem antes na fila.
    //
    // Vale secaoMostrada e não só abaAtual porque o normal é ninguém ter
    // tocado em aba nenhuma: o tablet abre na primeira e fica ali.
    var saiu = abaAtual || secaoMostrada;
    var substituta = lista.filter(function (r) {
      return r.replaces_section_id === saiu && secaoNoAr(r);
    })[0];
    if (substituta) return substituta;

    // Nada escolhido, ou a aba sumiu sem deixar substituta: cai na primeira
    // que está valendo agora. Só se nenhuma estiver é que abre uma fora de
    // hora — e isso só acontece com o admin, que é quem as enxerga.
    return lista.filter(secaoNoAr)[0] || lista[0];
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

  // ==================================================================
  //  HORÁRIO DO PRODUTO
  //  Prato que só sai das 11h às 15h some do alcance fora desse
  //  intervalo. O cartão CONTINUA na tela, apagado e com o horário
  //  escrito — sumir seria pior: o cliente acharia que acabou, e o
  //  garçom procuraria um item que existe.
  //
  //  A conta é feita com a HORA DA CASA, não com a do celular: um
  //  aparelho com o fuso trocado liberaria (ou barraria) na hora errada.
  //  De todo jeito, quem decide de verdade é o banco — isto aqui é só
  //  para a tela não oferecer o que vai ser recusado.
  // ==================================================================
  function horaDaCasa() {
    var fuso = (PL.ctx.cliente && PL.ctx.cliente.timezone) || "America/Sao_Paulo";
    try {
      var f = new Intl.DateTimeFormat("pt-BR", {
        timeZone: fuso, hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(new Date());
      var m = f.match(/(\d{1,2}):(\d{2})/);
      return m ? Number(m[1]) * 60 + Number(m[2]) : new Date().getHours() * 60 + new Date().getMinutes();
    } catch (e) {
      return new Date().getHours() * 60 + new Date().getMinutes();
    }
  }

  // "11:00:00" ou "11:00" -> minutos desde a meia-noite
  function emMinutos(hora) {
    var m = String(hora || "").match(/^(\d{1,2}):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  function horaCurta(hora) {
    var m = String(hora || "").match(/^(\d{1,2}):(\d{2})/);
    return m ? m[1].padStart(2, "0") + "h" + (m[2] === "00" ? "" : m[2]) : "";
  }

  function noHorario(p) {
    var de = emMinutos(p.available_from);
    var ate = emMinutos(p.available_to);
    if (de === null || ate === null || de === ate) return true;   // sem janela
    var agora = horaDaCasa();
    // janela que passa da meia-noite (18:00 às 02:00) é normal à noite
    return de < ate ? (agora >= de && agora < ate) : (agora >= de || agora < ate);
  }

  function janelaDoProduto(p) {
    var de = horaCurta(p.available_from), ate = horaCurta(p.available_to);
    return de && ate ? de + " às " + ate : "";
  }

  // ==================================================================
  //  QUAL CARDÁPIO VALE AGORA  (a aba noturna)
  //  ------------------------------------------------------------------
  //  Uma aba pode ter AGENDA (dias da semana + faixa de horário) e pode
  //  ESCONDER OUTRA enquanto está no ar. É assim que o cardápio noturno
  //  de terça e sexta entra e leva o cardápio do dia embora junto.
  //
  //  As mesmas contas existem no banco (app.secao_na_agenda). Aqui elas
  //  servem só para a tela não oferecer o que vai ser recusado; quem
  //  decide de verdade continua sendo o place_order.
  // ==================================================================
  function diasDaSecao(s) {
    var d = s && s.active_days;
    if (!Array.isArray(d)) return [];
    return d.map(Number).filter(function (n) { return n >= 0 && n <= 6; });
  }

  function secaoNaAgenda(s) {
    var dias = diasDaSecao(s);
    var de = emMinutos(s.active_from);
    var ate = emMinutos(s.active_to);
    var agora = horaDaCasa();

    if (de !== null && ate !== null && de !== ate) {
      var dentro = de < ate ? (agora >= de && agora < ate) : (agora >= de || agora < ate);
      if (!dentro) return false;
    }
    if (!dias.length) return true;

    var hoje = PL.diaDaCasa(PL.ctx.cliente && PL.ctx.cliente.timezone);
    // Janela que passa da meia-noite, e estamos na madrugada dela: o dia
    // que vale é o de ONTEM, quando a noite começou. Sem isto o cardápio
    // de terça sumiria à meia-noite em ponto, com o quiosque ainda cheio.
    if (de !== null && ate !== null && de > ate && agora < ate) hoje = (hoje + 6) % 7;
    return dias.indexOf(hoje) >= 0;
  }

  // Qual aba está ocupando o lugar desta agora — ou null se nenhuma.
  function quemEstaNoLugar(s) {
    if (!s) return null;
    return (PL.catalogo.secoes || []).filter(function (r) {
      return r.active !== false && r.replaces_section_id === s.id && secaoNaAgenda(r);
    })[0] || null;
  }

  // A aba aparece agora? Agenda dela E ninguém ocupando o lugar dela.
  function secaoNoAr(s) {
    if (!s || s.active === false) return false;
    if (!secaoNaAgenda(s)) return false;
    return !quemEstaNoLugar(s);
  }

  // Por que esta aba não está na tela do quiosque agora. São dois motivos
  // bem diferentes, e dizer o errado confunde justamente quem foi conferir:
  // ou a aba tem agenda e não é a hora dela, ou outra aba tomou o lugar.
  function porQueAbaSaiu(s) {
    var noLugar = quemEstaNoLugar(s);
    if (noLugar) {
      return "sai do ar enquanto o " + noLugar.label + " está valendo (" +
             PL.agendaEmPalavras(noLugar) + ")";
    }
    return "aparece " + PL.agendaEmPalavras(s);
  }

  // Tudo que MUDA SOZINHO com a passagem do tempo, num texto só: quais abas
  // estão no ar e quais produtos estão dentro da janela deles.
  //
  // Serve para redesenhar o cardápio na virada — às 18h o noturno assume, e
  // ninguém vai estar ali para apertar F5 — sem redesenhar de 20 em 20
  // segundos à toa: uma grade de 40 fotos piscando o dia inteiro num tablet
  // que fica ligado 12 horas é desperdício de bateria e de vista.
  function assinaturaDoRelogio() {
    var abas = (PL.catalogo.secoes || [])
      .map(function (s) { return s.id + (secaoNoAr(s) ? "1" : "0"); })
      .join("|");
    var itens = (PL.catalogo.produtos || [])
      .filter(function (p) { return p.available_from && p.available_to; })
      .map(function (p) { return p.id + (noHorario(p) ? "1" : "0"); })
      .join("|");
    return abas + "#" + itens;
  }

  // Por que este produto não pode ser pedido agora — ou "" se pode.
  function porQueNaoPode(p) {
    if (!p) return "Este item saiu do cardápio.";
    if (p.active === false) return "Este item está oculto do cardápio e não pode ser pedido.";
    if (p.available === false) return p.name + " está esgotado hoje.";
    var secao = (PL.catalogo.secoes || []).filter(function (s) { return s.id === p.section_id; })[0];
    if (secao && !secaoNoAr(secao)) return p.name + " é do " + secao.label + ", que não está valendo agora.";
    if (!noHorario(p)) return p.name + " só pode ser pedido das " + janelaDoProduto(p) + ".";
    return "";
  }

  function quiosquesAtivos() {
    return (PL.catalogo.quiosques || [])
      .filter(function (q) { return q.active !== false; })
      .sort(function (a, b) { return (a.number || 0) - (b.number || 0); });
  }

  // O quiosque desta tela: o do próprio perfil, ou o que o admin escolheu.
  // É dele que sai a hora em que a conta aberta começou.
  function quiosqueAtual() {
    if (PL.ctx.quiosque) {
      // o objeto do catálogo é o que carrega o session_started_at atualizado
      var doCatalogo = (PL.catalogo.quiosques || []).filter(function (q) {
        return q.id === PL.ctx.quiosque.id;
      })[0];
      return doCatalogo || PL.ctx.quiosque;
    }
    var id = quiosqueDoPedido();
    return id ? (PL.catalogo.quiosques || []).filter(function (q) { return q.id === id; })[0] || null : null;
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
    // Toda mudança do carrinho passa por aqui, então é o lugar certo para
    // reacertar o relógio da limpeza automática: um item a mais é sinal de
    // que tem gente ali, e um carrinho vazio não tem o que apagar.
    armarLimpezaDoCarrinho();
  }

  // Produto apagado, desligado ou esgotado depois que entrou no carrinho: sai
  // fora. O banco recusaria o pedido inteiro por causa dele (o place_order só
  // aceita produto active + available), e o quiosque ficaria sem entender.
  function limparCarrinhoFantasma() {
    var antes = carrinho.length;
    carrinho = carrinho.filter(function (l) {
      // fora de hora entra aqui também: o carrinho pode ter ficado aberto
      // desde o almoço, e às 15h01 aquele prato deixa de ser aceito — o
      // mesmo vale para o cardápio do dia quando o noturno assume às 18h
      return !porQueNaoPode(produtoPorId(l.product_id));
    });
    if (carrinho.length !== antes) {
      gravarCarrinho();
      PL.aviso("Tirei do pedido um item que saiu do cardápio ou passou do horário.", "avisa");
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

    // Esgotado ("acabou hoje"), oculto, fora do horário do produto ou de uma
    // aba que não está valendo agora: o cartão continua na tela — para o
    // quiosque saber que o item existe — mas não entra no pedido.
    //
    // O banco recusaria de todo jeito. Dizer o motivo aqui é melhor do que
    // deixar montar o pedido inteiro para ele voltar com erro no fim.
    var impedimento = porQueNaoPode(p);
    if (impedimento) {
      PL.aviso(impedimento, "avisa");
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
  //  O CARRINHO QUE SE APAGA SOZINHO
  //  ------------------------------------------------------------------
  //  O tablet do quiosque é de todo mundo. Quem escolhe três itens e vai
  //  embora sem enviar deixa o pedido dele esperando na tela — e o
  //  pescador seguinte, que nem reparou, manda tudo no nome dele. Pior:
  //  a recepção recebe um pedido que ninguém fez.
  //
  //  Passados alguns minutos sem NINGUÉM ENCOSTAR, o carrinho se apaga.
  //  O relógio é o mesmo tipo do descanso de tela: qualquer toque zera.
  //
  //  POR QUE SÓ NO TABLET
  //  No celular do próprio cliente ninguém herda carrinho de ninguém, e
  //  apagar a escolha de quem parou para pensar (ou foi atender uma
  //  ligação) seria só um estorvo.
  // ==================================================================
  var MINUTOS_LIMPAR_PADRAO = 3;
  var relogioCarrinho = null;

  function minutosParaLimpar() {
    var ajustes = (PL.ctx && PL.ctx.cliente && PL.ctx.cliente.settings) || {};
    var v = ajustes.carrinho_limpa_min;
    // 0 é um valor válido e quer dizer "nunca apaga" — por isso a conferência
    // é por vazio/ausente, e não por "se for falso"
    if (v === null || v === undefined || v === "") v = PL.CFG.carrinhoLimpaMinutos;
    if (v === null || v === undefined || v === "") v = MINUTOS_LIMPAR_PADRAO;
    v = Number(v);
    return isFinite(v) && v >= 0 ? v : MINUTOS_LIMPAR_PADRAO;
  }

  function podeLimparSozinho() {
    if (!PL.ehQuiosque() || PL.ehPublico()) return false;
    return minutosParaLimpar() > 0;
  }

  function armarLimpezaDoCarrinho() {
    clearTimeout(relogioCarrinho);
    if (!carrinho.length || !podeLimparSozinho()) return;

    relogioCarrinho = setTimeout(function () {
      // O pedido já está a caminho do banco: mexer no carrinho agora
      // deixaria a tela dizendo uma coisa e o banco outra.
      if (enviando) { armarLimpezaDoCarrinho(); return; }
      if (!carrinho.length || !podeLimparSozinho()) return;

      var minutos = minutosParaLimpar();
      esvaziarCarrinho();
      // o pop-up de conferência pode ter ficado aberto: sem fechar, ele
      // continuaria listando itens que não existem mais
      if (popCarrinho) { try { popCarrinho.fechar(); } catch (e) { /* já fechado */ } }
      atualizarTodosCartoes();
      desenharBarraCarrinho();
      PL.aviso("O pedido foi apagado por ficar " + minutos +
               (minutos === 1 ? " minuto" : " minutos") + " sem ninguém mexer.", "avisa");
    }, minutosParaLimpar() * 60000);
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

    // O catálogo — e a hora — podem ter mudado enquanto a tela estava fechada.
    limparCarrinhoFantasma();
    assinaturaRelogio = assinaturaDoRelogio();
    // O tablet pode ter recarregado sozinho com o carrinho de alguém dentro:
    // o relógio começa a contar de novo agora, e não de onde parou.
    armarLimpezaDoCarrinho();

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
      // O mural muda junto: os avisos escritos para um quiosque só valem
      // para o que está escolhido aqui.
      desenharSecao();
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
      // Só o admin chega a ver uma aba fora do ar; o relógio avisa que
      // aquilo ali é o cadastro, não o que o quiosque está vendo agora.
      var fora = !secaoNoAr(s);
      return '<button type="button" class="aba' + (s.id === atual.id ? " is-active" : "") +
        (fora ? " aba-fora" : "") +
        '" data-secao="' + PL.esc(s.id) + '"' +
        (fora ? ' title="' + PL.esc(s.label + " " + porQueAbaSaiu(s)) +
                '. Só você, como administrador, está vendo esta aba."' : "") + ">" +
        (s.icon ? '<span class="aba-icone">' + PL.esc(s.icon) + "</span>" : "") +
        "<span>" + PL.esc(s.label) + "</span>" +
        (fora ? '<span class="aba-relogio">🕐</span>' : "") +
        "</button>";
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
    // guardado ANTES de desenhar: é o que a próxima virada de horário vai
    // consultar para saber de onde a pessoa veio
    secaoMostrada = secao ? secao.id : null;

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

    // Aba fora do horário dela: uma faixa em cima explica de uma vez só, em
    // vez de repetir a mesma etiqueta em cada um dos 30 cartões.
    // Só o admin chega aqui — para o quiosque a aba nem aparece.
    if (!secaoNoAr(secao)) {
      html += '<div class="recado-fase fase-espera">🕐 <b>' + PL.esc(secao.label) +
        "</b> " + PL.esc(porQueAbaSaiu(secao)) +
        ". Você está vendo esta aba porque é administrador; no tablet do quiosque ela está escondida.</div>";
    }

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
    var foraDeHora = !noHorario(p);
    var foraDaAba = !secaoNoAr(secao);
    var qtd = qtdNoCarrinho(p.id);

    // .esgotado deixa o cartão apagado; serve igualmente para o item oculto,
    // para o que está fora de hora e para o de uma aba que não está valendo
    // agora, porque nos quatro casos ele está na tela só como informação.
    var classes = "produto" + (esgotado || oculto || foraDeHora || foraDaAba ? " esgotado" : "");

    var foto = p.image_url
      ? '<img class="produto-foto" src="' + PL.esc(p.image_url) + '" alt="" loading="lazy">'
      : '<div class="produto-sem-foto">' + PL.esc(secao.icon || "🍽️") + "</div>";

    var selo = oculto
      ? '<span class="selo-oculto">Oculto</span>'
      : (esgotado ? '<span class="selo-esgotado">Esgotado</span>'
        : (foraDeHora ? '<span class="selo-horario">🕐 ' + PL.esc(janelaDoProduto(p)) + "</span>" : ""));

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
    // O quiosque DA TELA, e não o do perfil: o admin não tem quiosque
    // próprio, ele escolhe um ali em cima. Lendo o perfil, ele nunca veria
    // um aviso feito para um quiosque só — justamente o que ele quer
    // conferir depois de escrever "a tomada do 7 está em manutenção".
    var qAtual = quiosqueAtual();
    var meuQuiosque = qAtual ? qAtual.id : null;

    var lista = (PL.catalogo.dicas || [])
      .filter(function (d) {
        if (d.section_id !== secao.id || d.active === false) return false;
        // dica sem quiosque vale para todo mundo; com quiosque, só para ele
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
        popCarrinho = null;
        atualizarTodosCartoes();
        desenharBarraCarrinho();
      },
    });

    // guardado para a limpeza automática poder fechar este pop-up: sem
    // isso ele continuaria listando itens que já foram apagados
    popCarrinho = pop;

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
            // A descrição é o que distingue dois itens de nome parecido
            // ("porção" e "porção grande"). Na hora de conferir o pedido é
            // justamente quando a pessoa quer ter certeza do que escolheu.
            (p.description ? '<span class="ci-desc">' + PL.esc(p.description) + "</span>" : "") +
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
  //
  // E só entram os da CONTA ABERTA: quando a recepção encerra o turno (ou
  // quando passa a hora da virada), o pescador que chega não pode ver o
  // consumo de quem estava aqui antes dele.
  function meusPedidos() {
    var meu = (PL.ctx.perfil && PL.ctx.perfil.kiosk_id) || quiosqueDoPedido();
    var quiosque = quiosqueAtual();
    var desde = quiosque ? PL.inicioDaSessao(quiosque) : 0;

    var lista = (PL.pedidos || []).filter(function (p) {
      if (meu && p.kiosk_id !== meu) return false;
      return new Date(p.created_at).getTime() >= desde;
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
    // A FASE entra na conta: o pedido continua 'lancado' no banco, mas ao
    // passar dos minutos o "já estamos levando" precisa virar "finalizado"
    // sozinho — e sem a fase aqui a tela nunca redesenharia.
    return lista.map(function (p) {
      return p.id + ":" + p.status + ":" + p.updated_at + ":" + faseDoPedido(p);
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
    var fase = faseDoPedido(p);
    var f = FASES[fase];
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
      '<span class="status-chip ' + f.classe + '">' + f.icone + " " + PL.esc(f.rotulo) + "</span>" +
      (p.table_label ? '<span class="meta">📍 ' + PL.esc(p.table_label) + "</span>" : "") +
      (p.customer_name ? '<span class="meta">🙋 ' + PL.esc(p.customer_name) + "</span>" : "") +
      (p.notes ? '<span class="meta obs">📝 ' + PL.esc(p.notes) + "</span>" : "") +
      (p.error_reason ? '<span class="meta erro">⚠ ' + PL.esc(p.error_reason) + "</span>" : "");

    // A frase de acompanhamento é o que o cliente lê primeiro. Ela some
    // quando o pedido finaliza — aí não há mais nada a dizer.
    var recado = f.recado
      ? '<div class="recado-fase fase-' + fase + '">' + f.icone + " " + PL.esc(f.recado) + "</div>"
      : "";

    var acoes = p.status === "recebido"
      ? '<button type="button" class="btn btn-danger btn-sm" data-cancelar="' + PL.esc(p.id) + '">Cancelar</button>'
      : '<span class="hint">' + PL.esc(f.icone + " " + f.rotulo) + "</span>";

    return '<article class="pedido' + (aberto && min >= atrasadoEm() ? " atrasado" : "") +
      (fase === "levando" ? " levando" : "") +
      '" data-status="' + PL.esc(p.status) + '" data-fase="' + fase + '">' +
      recado +
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

  // ==================================================================
  //  EM QUE PÉ ESTÁ O PEDIDO, DO PONTO DE VISTA DE QUEM PEDIU
  //  ------------------------------------------------------------------
  //  No banco existe um estado só depois que a recepção resolve:
  //  'lancado'. Mas "lançado" não quer dizer nada para o cliente — ele
  //  quer saber se a comida está vindo.
  //
  //  Então a tela conta o tempo: nos primeiros minutos depois de lançado
  //  ela diz "já estamos levando", e passado esse prazo vira "finalizado".
  //  Quem faz isso é o RELÓGIO, não um botão — assim a recepção não
  //  precisa voltar no pedido para dizer que entregou.
  // ==================================================================
  // Cuidado com o zero: aqui ele é um valor VÁLIDO — quer dizer "não mostre
  // 'já estamos levando', finalize assim que a recepção lançar". Um
  // `Number(x) || 10` engoliria esse zero e voltaria calado para 10 minutos.
  function minutosACaminho() {
    var s = (PL.ctx.cliente && PL.ctx.cliente.settings) || {};
    var v = s.minutosACaminho;
    if (v === null || v === undefined || v === "") v = PL.CFG.minutosACaminho;
    v = Number(v);
    return isFinite(v) && v >= 0 ? v : 10;
  }

  function faseDoPedido(p) {
    if (p.status === "recebido") return "espera";
    if (p.status === "erro" || p.status === "cancelado") return "problema";
    if (p.status !== "lancado") return "espera";
    var desde = PL.minutosDesde(p.launched_at || p.updated_at || p.created_at);
    return desde < minutosACaminho() ? "levando" : "pronto";
  }

  var FASES = {
    espera:   { rotulo: "Recebido",            icone: "🔔", classe: "status-recebido",
                recado: "A recepção já está vendo o seu pedido." },
    levando:  { rotulo: "Já estamos levando!", icone: "🛎️", classe: "chip-levando",
                recado: "Fique no quiosque — alguém leva até você." },
    pronto:   { rotulo: "Finalizado",          icone: "✅", classe: "status-lancado",
                recado: "" },
    problema: { rotulo: "Não deu certo",       icone: "⚠️", classe: "status-erro",
                recado: "Fale com o atendente do quiosque." },
  };

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
  // Qualquer sinal de vida adia a limpeza do carrinho. Vai no documento
  // inteiro e na fase de CAPTURA para valer também dentro de um pop-up e
  // por baixo da propaganda, que come o toque antes de ele chegar à tela.
  ["pointerdown", "keydown", "wheel", "touchstart"].forEach(function (ev) {
    document.addEventListener(ev, armarLimpezaDoCarrinho, { capture: true, passive: true });
  });

  PL.ao("catalogo", function () {
    if (!telaCardapioAtiva) return;
    limparCarrinhoFantasma();
    // a agenda das abas pode ter sido mexida agora mesmo pelo admin
    assinaturaRelogio = assinaturaDoRelogio();
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
    if (telaPedidosAtiva) {
      // A fase pode virar sozinha com o tempo ("já estamos levando" →
      // "finalizado"), sem nada mudar no banco. desenharMeusPedidos só
      // redesenha se a assinatura mudou; senão apenas acerta os relógios.
      desenharMeusPedidos();
    }

    if (telaCardapioAtiva) {
      // A virada do cardápio noturno (e o fim da janela de um produto)
      // acontece pelo relógio, sem nada mudar no banco — ninguém vai
      // estar no quiosque às 18h em ponto para recarregar a página.
      var agora = assinaturaDoRelogio();
      if (agora !== assinaturaRelogio) {
        assinaturaRelogio = agora;
        limparCarrinhoFantasma();
        desenharAbas();
        desenharSecao();
        desenharBarraCarrinho();
      }
    }
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
      assinaturaRelogio = null;
      secaoMostrada = null;
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
