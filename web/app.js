/* 股票分析看板前端：原生 JS + ECharts，按移动端交互设计。 */
(function () {
  'use strict';

  var STORAGE = { code: 'stockTool.code', token: 'stockTool.token', recent: 'stockTool.recent' };

  var state = {
    code: '',
    token: '',
    tab: 'home',
    period: 'day',
    adjust: 1,
    limit: 250,
    isFav: false,
    home: null,
    hot: null,
    market: null,
    homeTab: 'hot',
    favCodes: [],
    loaded: { overview: false, trend: false, financial: false, peers: false },
    data: { overview: null, kline: null, financial: null, peers: null },
    charts: {}
  };

  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  };

  /* ------------------------------------------------------------ 格式化 */

  function num(v, digits) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return Number(v).toFixed(digits === undefined ? 2 : digits);
  }

  function signed(v, digits, unit) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    var n = Number(v);
    return (n > 0 ? '+' : '') + n.toFixed(digits === undefined ? 2 : digits) + (unit || '');
  }

  function money(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    var n = Number(v);
    if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + '亿';
    if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(2) + '万';
    return n.toFixed(2);
  }

  function hands(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    var n = Number(v);
    return Math.abs(n) >= 1e4 ? (n / 1e4).toFixed(2) + '万手' : n.toFixed(0) + '手';
  }

  function trendClass(v) {
    if (v === null || v === undefined || isNaN(v) || Number(v) === 0) return 'flat';
    return Number(v) > 0 ? 'up' : 'down';
  }

  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function metric(label, value, cls) {
    var box = el('div', 'metric');
    box.appendChild(el('div', 'metric__label', label));
    box.appendChild(el('div', 'metric__value' + (cls ? ' ' + cls : ''), value));
    return box;
  }

  function toast(message) {
    var node = $('toast');
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { node.hidden = true; }, 2800);
  }

  /* ------------------------------------------------------------ 网络 */

  // 页面可能挂在根路径或子路径（如 https://dodomogu.com/stock/）下，
  // 接口地址按当前目录拼相对路径，避免写死绝对路径导致子目录下 404。
  var BASE_PATH = location.pathname.replace(/[^/]*$/, '');

  function api(path, method, body) {
    var url = BASE_PATH + String(path).replace(/^\//, '');
    if (state.token) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(state.token);
    var options = { method: method || 'GET', headers: { Accept: 'application/json' } };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    return fetch(url, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (res.status === 401) {
          var err = new Error('需要访问口令：请在网址后加 ?token=你的口令');
          err.unauthorized = true;
          throw err;
        }
        if (!res.ok || !body.ok) throw new Error((body && (body.error || body.detail)) || ('请求失败 ' + res.status));
        state.serverTime = body.server_time;
        return body.data;
      });
    });
  }

  function showState(message, retry) {
    var block = $('stateBlock');
    $('stateText').textContent = message;
    block.hidden = false;
    $('btnRetry').onclick = retry || function () { loadTab(state.tab, true); };
    Array.prototype.forEach.call(document.querySelectorAll('.tab-panel'), function (p) { p.hidden = true; });
  }

  function hideState() {
    $('stateBlock').hidden = true;
    switchTab(state.tab, true);
  }

  /* ------------------------------------------------------------ 概览 */

  function renderOverview(payload) {
    var quote = payload.quote || {};
    var a = payload.analysis || {};

    document.title = (quote.name || state.code) + ' ' + state.code;
    $('stockName').textContent = quote.name || state.code;
    $('stockCode').textContent = state.code;

    // 价格卡
    var card = $('priceCard');
    card.innerHTML = '';
    var main = el('div', 'price-main');
    var left = el('div');
    left.appendChild(el('div', 'price-value ' + trendClass(quote.pct_chg), num(quote.price)));
    // 行情源名称按实际来源显示，避免新增源后被笼统标成主源
    var SOURCE_LABEL = { eastmoney: '东方财富', tencent: '腾讯', sina: '新浪' };
    var sourceNote = SOURCE_LABEL[quote.source] || quote.source || '未知源';
    if (quote.stale) sourceNote += ' · 缓存数据';
    else if (quote.fields_filled) sourceNote += ' · 部分字段由缓存补齐';
    left.appendChild(el('div', 'metric__label', '数据源：' + sourceNote +
      (state.serverTime ? ' · 更新于 ' + state.serverTime : '')));
    var right = el('div', 'price-delta ' + trendClass(quote.pct_chg));
    right.innerHTML = signed(quote.change) + '<br>' + signed(quote.pct_chg, 2, '%');
    main.appendChild(left);
    main.appendChild(right);
    card.appendChild(main);

    // 关键指标
    var grid = $('keyMetrics');
    grid.innerHTML = '';
    var metrics = el('div', 'metric-grid');
    [
      ['今开', num(quote.open)],
      ['最高', num(quote.high)],
      ['最低', num(quote.low)],
      ['昨收', num(quote.prev_close)],
      ['成交量', hands(quote.volume)],
      ['成交额', money(quote.amount)],
      ['换手率', quote.turnover === null || quote.turnover === undefined ? '—' : num(quote.turnover) + '%'],
      ['振幅', quote.amplitude === null || quote.amplitude === undefined ? '—' : num(quote.amplitude) + '%'],
      ['量比', num(quote.volume_ratio)],
      ['总市值', money(quote.market_cap)],
      ['流通市值', money(quote.float_market_cap)],
      ['PE(动)', num(quote.pe_dynamic)]
    ].forEach(function (row) { metrics.appendChild(metric(row[0], row[1])); });
    grid.appendChild(metrics);

    // 估值卡
    var val = a.valuation || {};
    var valCard = $('valuationCard');
    valCard.innerHTML = '';
    if (val.available) {
      valCard.appendChild(el('h3', 'card__title', '估值位置'));
      var vg = el('div', 'metric-grid');
      vg.appendChild(metric('PE(TTM)', num(val.pe_ttm), val.pe_positive === false ? 'flat' : ''));
      vg.appendChild(metric('PE 历史分位', val.pe_percentile === null || val.pe_percentile === undefined ? '—' : num(val.pe_percentile, 1) + '%'));
      vg.appendChild(metric('PE 中位数', num(val.pe_median)));
      vg.appendChild(metric('PB', num(val.pb)));
      vg.appendChild(metric('PB 历史分位', val.pb_percentile === null || val.pb_percentile === undefined ? '—' : num(val.pb_percentile, 1) + '%'));
      vg.appendChild(metric('PB 中位数', num(val.pb_median)));
      valCard.appendChild(vg);
      if (val.avg_percentile !== null && val.avg_percentile !== undefined) {
        var gauge = el('div', 'gauge');
        var track = el('div', 'gauge__track');
        var pin = el('div', 'gauge__pin');
        pin.style.left = Math.max(0, Math.min(100, val.avg_percentile)) + '%';
        track.appendChild(pin);
        gauge.appendChild(track);
        var scale = el('div', 'gauge__scale');
        scale.appendChild(el('span', null, '估值分位低'));
        scale.appendChild(el('span', null, num(val.avg_percentile, 1) + '%'));
        scale.appendChild(el('span', null, '估值分位高'));
        gauge.appendChild(scale);
        valCard.appendChild(gauge);
      }
      valCard.appendChild(el('p', 'signal__detail', val.summary || ''));
      if (val.pe_note) valCard.appendChild(el('p', 'signal__detail', val.pe_note));
      valCard.appendChild(el('p', 'signal__detail', '样本区间：' + (val.span || '—') + '，共 ' + (val.sample_days || 0) + ' 个交易日'));
    } else {
      valCard.appendChild(el('p', 'empty', '估值数据不可用：' + (val.reason || '未知原因')));
    }

    // 推荐指数（概览页主卡）
    var scoreCard = $('scoreCard');
    scoreCard.innerHTML = '';
    var rec = a.recommendation || {};
    var pos = a.position || {};
    var hero = el('div', 'hero');

    var top = el('div', 'hero__top');
    var numBox = el('div', 'hero__num-box');
    numBox.appendChild(el('div', 'metric__label', '推荐指数'));
    var numHtml = '<div class="hero__num' + (rec.rating_level ? ' hero__num--' + rec.rating_level : '') + '">' +
      (rec.index === null || rec.index === undefined ? '—' : num(rec.index, 0)) + '<small> / 100</small></div>';
    numBox.innerHTML += numHtml;
    top.appendChild(numBox);
    var sideBox = el('div', 'hero__side');
    sideBox.appendChild(el('span', 'badge badge--' + (rec.rating_level || 'neutral'), rec.rating || '—'));
    sideBox.appendChild(el('div', 'hero__hint', '规则评分，不是上涨概率'));
    top.appendChild(sideBox);
    hero.appendChild(top);

    if (rec.index !== null && rec.index !== undefined) {
      var heroBar = el('div', 'hero__bar');
      var heroFill = el('div', 'hero__bar-fill' + (rec.rating_level ? ' hero__bar-fill--' + rec.rating_level : ''));
      heroFill.style.width = Math.max(2, Math.min(100, rec.index)) + '%';
      heroBar.appendChild(heroFill);
      hero.appendChild(heroBar);
    }

    var dimList = el('div', 'dim-list');
    (rec.breakdown || []).forEach(function (d) {
      var row = el('div', 'dim' + (d.available ? '' : ' dim--off'));
      row.appendChild(el('span', 'dim__label', d.label));
      var track = el('div', 'dim__bar');
      var fillBar = el('div', 'dim__fill' + (d.available && d.score >= 65 ? ' dim__fill--good'
        : d.available && d.score < 40 ? ' dim__fill--bad' : ''));
      fillBar.style.width = (d.available ? Math.max(2, Math.min(100, d.score)) : 0) + '%';
      track.appendChild(fillBar);
      row.appendChild(track);
      row.appendChild(el('span', 'dim__val', d.available ? num(d.score, 0) : '无数据'));
      row.title = (d.detail || '') + '（基础权重 ' + d.base_weight + '%）';
      dimList.appendChild(row);
    });
    hero.appendChild(dimList);

    if (pos.available) {
      var posBox = el('div', 'hero__pos');
      posBox.appendChild(el('div', 'section-title', '年线位置'));
      var posGrid = el('div', 'metric-grid');
      posGrid.appendChild(metric('年线(MA250)', num(pos.ma250)));
      posGrid.appendChild(metric('乖离率', signed(pos.bias, 1, '%')));
      posGrid.appendChild(metric('乖离分位', num(pos.bias_percentile, 0) + '%'));
      posGrid.appendChild(metric('年线趋势', pos.slope_trend || '—'));
      posGrid.appendChild(metric('20 日斜率', signed(pos.slope, 2, '%')));
      posGrid.appendChild(metric('一年区间分位', num(pos.range_position && pos.range_position.pct, 0) + '%'));
      posBox.appendChild(posGrid);
      hero.appendChild(posBox);
    }

    var drivers = rec.drivers || {};
    if ((drivers.positive || []).length || (drivers.negative || []).length) {
      var drv = el('div', 'hero__drivers');
      (drivers.positive || []).forEach(function (d) {
        drv.appendChild(el('span', 'chip chip--up', '↑ ' + d.label + ' ' + num(d.score, 0)));
      });
      (drivers.negative || []).forEach(function (d) {
        drv.appendChild(el('span', 'chip chip--down', '↓ ' + d.label + ' ' + num(d.score, 0)));
      });
      hero.appendChild(drv);
    }
    (rec.cautions || []).forEach(function (text) {
      hero.appendChild(el('p', 'hero__caution', '注意：' + text));
    });
    if (rec.method) {
      var methodBox = el('details', 'hero__method');
      methodBox.appendChild(el('summary', null, '这个分数怎么来的'));
      methodBox.appendChild(el('p', null, rec.method + '。'));
      if (rec.disclaimer) methodBox.appendChild(el('p', null, rec.disclaimer));
      hero.appendChild(methodBox);
    }
    scoreCard.appendChild(hero);

    state.isFav = !!payload.is_favorite;
    updateStar();

    // 信号卡
    var signalCard = $('signalCard');
    signalCard.innerHTML = '';
    signalCard.appendChild(el('h3', 'card__title', '信号明细'));
    var sections = [
      ['技术面', (a.trend && a.trend.signals) || []],
      ['财务面', (a.financial && a.financial.signals) || []],
      ['同业', (a.peer && a.peer.signals) || []]
    ];
    sections.forEach(function (sec) {
      if (!sec[1].length) return;
      signalCard.appendChild(el('div', 'section-title', sec[0]));
      sec[1].forEach(function (s) {
        var row = el('div', 'signal');
        row.appendChild(el('span', 'signal__dot signal__dot--' + (s.level || 'neutral')));
        var body = el('div', 'signal__body');
        body.appendChild(el('div', 'signal__label', s.label));
        body.appendChild(el('div', 'signal__detail', s.detail));
        row.appendChild(body);
        signalCard.appendChild(row);
      });
    });
    if (a.conclusion) {
      signalCard.appendChild(el('div', 'section-title', '结论'));
      signalCard.appendChild(el('p', 'conclusion', a.conclusion));
    }

    // 风险卡
    var riskCard = $('riskCard');
    riskCard.innerHTML = '';
    riskCard.appendChild(el('h3', 'card__title', '风险提示'));
    if ((a.risks || []).length) {
      var ul = el('ul', 'risk-list');
      a.risks.forEach(function (r) { ul.appendChild(el('li', null, r)); });
      riskCard.appendChild(ul);
    } else {
      riskCard.appendChild(el('p', 'empty', '当前规则未触发特定风险提示，仍需自行核查公告与行业变化。'));
    }

    // 数据说明
    var noticeList = $('noticeList');
    noticeList.innerHTML = '';
    (a.notices || []).forEach(function (n) { noticeList.appendChild(el('li', null, n)); });
    var degraded = payload.degraded || a.degraded || [];
    if (degraded.length) {
      noticeList.appendChild(el('li', null, '本次部分数据源不可用，已用缓存或降级数据展示：' + degraded.join('；')));
      toast('部分数据源暂不可用，展示的是缓存数据');
    }
  }

  /* ------------------------------------------------------------ 走势 */

  function renderTrend(payload) {
    var rows = payload.rows || [];
    var ind = payload.indicators || {};
    if (!rows.length) { $('chartKline').innerHTML = '<p class="empty">无K线数据</p>'; return; }

    var dates = rows.map(function (r) { return r.date; });
    var candles = rows.map(function (r) { return [r.open, r.close, r.low, r.high]; });
    var vols = rows.map(function (r, i) {
      var prev = i > 0 ? rows[i - 1].close : r.open;
      return { value: r.volume, itemStyle: { color: r.close >= prev ? '#f0483e' : '#14b87f', opacity: 0.65 } };
    });
    var macd = ind.macd || { dif: [], dea: [], hist: [] };
    var histBars = (macd.hist || []).map(function (v) {
      return { value: v, itemStyle: { color: v >= 0 ? '#f0483e' : '#14b87f' } };
    });

    function ma(key, color) {
      return {
        name: key.toUpperCase(), type: 'line', data: ind[key] || [], smooth: true, showSymbol: false,
        lineStyle: { width: 1.2, color: color }, itemStyle: { color: color }, xAxisIndex: 0, yAxisIndex: 0
      };
    }

    var option = {
      animation: false,
      backgroundColor: 'transparent',
      textStyle: { color: '#8b99ab', fontSize: 10 },
      grid: [
        { left: 8, right: 28, top: 18, height: '48%', containLabel: true },
        { left: 8, right: 28, top: '63%', height: '12%', containLabel: true },
        { left: 8, right: 28, top: '79%', height: '17%', containLabel: true }
      ],
      axisPointer: { link: [{ xAxisIndex: 'all' }], label: { backgroundColor: '#2b3648' } },
      tooltip: {
        trigger: 'axis', confine: true, backgroundColor: 'rgba(21,28,38,0.95)',
        borderColor: '#232d3b', textStyle: { color: '#e8eef6', fontSize: 11 },
        axisPointer: { type: 'cross', crossStyle: { color: '#4c8dff' } },
        formatter: function (params) {
          if (!params.length) return '';
          var idx = params[0].dataIndex;
          var r = rows[idx];
          var lines = [r.date, '开 ' + num(r.open) + '  收 ' + num(r.close),
            '高 ' + num(r.high) + '  低 ' + num(r.low),
            '涨跌 ' + signed(r.pct_chg, 2, '%'),
            '量 ' + hands(r.volume)];
          ['ma5', 'ma10', 'ma20', 'ma60'].forEach(function (k) {
            if (ind[k] && ind[k][idx] !== null && ind[k][idx] !== undefined) {
              lines.push(k.toUpperCase() + ' ' + num(ind[k][idx]));
            }
          });
          if (macd.dif && macd.dif[idx] !== undefined) {
            lines.push('DIF ' + num(macd.dif[idx], 3) + '  DEA ' + num(macd.dea[idx], 3));
          }
          return lines.join('<br>');
        }
      },
      legend: {
        data: ['MA5', 'MA10', 'MA20', 'MA60'], top: 0, right: 0, itemWidth: 12, itemHeight: 2,
        textStyle: { color: '#8b99ab', fontSize: 10 }
      },
      xAxis: [
        { type: 'category', data: dates, boundaryGap: true, axisLine: { lineStyle: { color: '#232d3b' } }, axisLabel: { show: false }, splitLine: { show: false } },
        { type: 'category', gridIndex: 1, data: dates, boundaryGap: true, axisLine: { lineStyle: { color: '#232d3b' } }, axisLabel: { show: false }, splitLine: { show: false } },
        { type: 'category', gridIndex: 2, data: dates, boundaryGap: true, axisLine: { lineStyle: { color: '#232d3b' } }, axisLabel: { color: '#8b99ab', fontSize: 9, hideOverlap: true, showMinLabel: false, interval: 'auto' }, splitLine: { show: false } }
      ],
      yAxis: [
        { scale: true, splitNumber: 3, axisLabel: { color: '#8b99ab', fontSize: 9 }, splitLine: { lineStyle: { color: '#1c2531' } } },
        { gridIndex: 1, splitNumber: 2, axisLabel: { show: false }, splitLine: { show: false } },
        { gridIndex: 2, splitNumber: 2, axisLabel: { show: false }, splitLine: { lineStyle: { color: '#1c2531' } } }
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1, 2], start: 0, end: 100, minValueSpan: 10 }
      ],
      series: [
        {
          name: 'K线', type: 'candlestick', data: candles, xAxisIndex: 0, yAxisIndex: 0,
          itemStyle: { color: '#f0483e', color0: '#14b87f', borderColor: '#f0483e', borderColor0: '#14b87f' }
        },
        ma('ma5', '#f0a83e'), ma('ma10', '#4c8dff'), ma('ma20', '#c06ef0'), ma('ma60', '#4dd0c1'),
        { name: '成交量', type: 'bar', data: vols, xAxisIndex: 1, yAxisIndex: 1, barWidth: '70%' },
        { name: 'MACD', type: 'bar', data: histBars, xAxisIndex: 2, yAxisIndex: 2, barWidth: '60%' },
        { name: 'DIF', type: 'line', data: macd.dif || [], xAxisIndex: 2, yAxisIndex: 2, showSymbol: false, lineStyle: { width: 1.1, color: '#f0a83e' }, itemStyle: { color: '#f0a83e' } },
        { name: 'DEA', type: 'line', data: macd.dea || [], xAxisIndex: 2, yAxisIndex: 2, showSymbol: false, lineStyle: { width: 1.1, color: '#4c8dff' }, itemStyle: { color: '#4c8dff' } }
      ]
    };

    var chart = state.charts.kline || echarts.init($('chartKline'), null, { renderer: 'canvas' });
    state.charts.kline = chart;
    chart.setOption(option, true);
    chart.resize();

    // 指标明细
    var last = rows.length - 1;
    var t = state.data.overview && state.data.overview.analysis && state.data.overview.analysis.trend;
    var box = $('techMetrics');
    box.innerHTML = '';
    box.appendChild(el('h3', 'card__title', '指标明细（最新交易日）'));
    var grid = el('div', 'metric-grid');
    ['ma5', 'ma10', 'ma20', 'ma60', 'ma250'].forEach(function (k) {
      if (ind[k] && ind[k][last] !== undefined) grid.appendChild(metric(k.toUpperCase(), num(ind[k][last])));
    });
    if (ind.rsi14) grid.appendChild(metric('RSI(14)', num(ind.rsi14[last])));
    if (ind.kdj && ind.kdj.k) grid.appendChild(metric('KDJ-K', num(ind.kdj.k[last])));
    if (ind.atr14) grid.appendChild(metric('ATR(14)', num(ind.atr14[last])));
    if (ind.boll && ind.boll.upper) {
      grid.appendChild(metric('布林上轨', num(ind.boll.upper[last])));
      grid.appendChild(metric('布林下轨', num(ind.boll.lower[last])));
    }
    box.appendChild(grid);
    if (t && t.available) {
      box.appendChild(el('p', 'signal__detail', '均线结构：' + t.alignment + '；区间位置：' +
        (t.position_250d && t.position_250d.pct !== null ? t.position_250d.pct + '%（近一年）' : '—')));
    }
  }

  /* ------------------------------------------------------------ 财务 */

  function renderFinancial(payload) {
    var records = payload.records || [];
    var box = $('finLatest');
    box.innerHTML = '';
    if (!records.length) { box.appendChild(el('p', 'empty', '无财报数据')); return; }

    var latest = records[0];
    box.appendChild(el('h3', 'card__title', '最新报告期 · ' + (latest.report_date_name || latest.report_date)));
    var grid = el('div', 'metric-grid');
    var fin = state.data.overview && state.data.overview.analysis && state.data.overview.analysis.financial;
    [
      ['营业收入', money(latest.totaloperatereve)],
      ['营收同比', signed(latest.totaloperaterevetz, 1, '%')],
      ['归母净利', money(latest.parentnetprofit)],
      ['净利同比', signed(latest.parentnetprofittz, 1, '%')],
      ['每股收益', num(latest.epsjb)],
      ['每股净资产', num(latest.bps)],
      ['ROE', latest.roejq === null || latest.roejq === undefined ? '—' : num(latest.roejq) + '%'],
      ['销售毛利率', latest.xsmll === null || latest.xsmll === undefined ? '—' : num(latest.xsmll) + '%'],
      ['销售净利率', latest.xsjll === null || latest.xsjll === undefined ? '—' : num(latest.xsjll) + '%'],
      ['资产负债率', latest.zcfzl === null || latest.zcfzl === undefined ? '—' : num(latest.zcfzl) + '%'],
      ['每股经营现金流', num(latest.mgjyxjje)]
    ].forEach(function (row) {
      var cls = '';
      if (row[0].indexOf('同比') >= 0) cls = trendClass(row[1] === '—' ? null : parseFloat(row[1]));
      grid.appendChild(metric(row[0], row[1], cls));
    });
    box.appendChild(grid);
    if (fin && fin.available && fin.latest && fin.latest.cash_quality !== null) {
      box.appendChild(el('p', 'signal__detail', '利润含金量（每股经营现金流 / 每股收益）：' + num(fin.latest.cash_quality)));
    }

    var ordered = records.slice().reverse();
    var labels = ordered.map(function (r) { return r.report_date_name || r.report_date; });

    var revChart = state.charts.revenue || echarts.init($('chartRevenue'), null, { renderer: 'canvas' });
    state.charts.revenue = revChart;
    revChart.setOption({
      animation: false, backgroundColor: 'transparent',
      textStyle: { color: '#8b99ab', fontSize: 10 },
      grid: { left: 6, right: 6, top: 30, bottom: 4, containLabel: true },
      tooltip: { trigger: 'axis', confine: true, backgroundColor: 'rgba(21,28,38,0.95)', borderColor: '#232d3b', textStyle: { color: '#e8eef6', fontSize: 11 } },
      legend: { data: ['营业收入', '归母净利', '营收同比', '净利同比'], top: 0, textStyle: { color: '#8b99ab', fontSize: 10 }, itemWidth: 12, itemHeight: 8 },
      xAxis: { type: 'category', data: labels, axisLabel: { color: '#8b99ab', fontSize: 9, interval: 0, rotate: 30 }, axisLine: { lineStyle: { color: '#232d3b' } } },
      yAxis: [
        { type: 'value', axisLabel: { color: '#8b99ab', fontSize: 9, formatter: function (v) { return (v / 1e8).toFixed(0) + '亿'; } }, splitLine: { lineStyle: { color: '#1c2531' } } },
        { type: 'value', axisLabel: { color: '#8b99ab', fontSize: 9, formatter: '{value}%' }, splitLine: { show: false } }
      ],
      series: [
        { name: '营业收入', type: 'bar', data: ordered.map(function (r) { return r.totaloperatereve; }), itemStyle: { color: '#4c8dff' }, barMaxWidth: 18 },
        { name: '归母净利', type: 'bar', data: ordered.map(function (r) { return r.parentnetprofit; }), itemStyle: { color: '#f0a83e' }, barMaxWidth: 18 },
        { name: '营收同比', type: 'line', yAxisIndex: 1, data: ordered.map(function (r) { return r.totaloperaterevetz; }), showSymbol: true, symbolSize: 4, lineStyle: { color: '#8fc0ff', width: 1.4 }, itemStyle: { color: '#8fc0ff' } },
        { name: '净利同比', type: 'line', yAxisIndex: 1, data: ordered.map(function (r) { return r.parentnetprofittz; }), showSymbol: true, symbolSize: 4, lineStyle: { color: '#f6c667', width: 1.4 }, itemStyle: { color: '#f6c667' } }
      ]
    }, true);
    revChart.resize();

    var profChart = state.charts.profit || echarts.init($('chartProfitability'), null, { renderer: 'canvas' });
    state.charts.profit = profChart;
    profChart.setOption({
      animation: false, backgroundColor: 'transparent',
      textStyle: { color: '#8b99ab', fontSize: 10 },
      grid: { left: 6, right: 6, top: 30, bottom: 4, containLabel: true },
      tooltip: { trigger: 'axis', confine: true, backgroundColor: 'rgba(21,28,38,0.95)', borderColor: '#232d3b', textStyle: { color: '#e8eef6', fontSize: 11 }, valueFormatter: function (v) { return v === null || v === undefined ? '—' : Number(v).toFixed(2) + '%'; } },
      legend: { data: ['毛利率', '净利率', 'ROE', '资产负债率'], top: 0, textStyle: { color: '#8b99ab', fontSize: 10 }, itemWidth: 12, itemHeight: 8 },
      xAxis: { type: 'category', data: labels, axisLabel: { color: '#8b99ab', fontSize: 9, interval: 0, rotate: 30 }, axisLine: { lineStyle: { color: '#232d3b' } } },
      yAxis: { type: 'value', axisLabel: { color: '#8b99ab', fontSize: 9, formatter: '{value}%' }, splitLine: { lineStyle: { color: '#1c2531' } } },
      series: [
        { name: '毛利率', type: 'line', data: ordered.map(function (r) { return r.xsmll; }), showSymbol: true, symbolSize: 4, lineStyle: { color: '#4c8dff', width: 1.4 }, itemStyle: { color: '#4c8dff' } },
        { name: '净利率', type: 'line', data: ordered.map(function (r) { return r.xsjll; }), showSymbol: true, symbolSize: 4, lineStyle: { color: '#f0a83e', width: 1.4 }, itemStyle: { color: '#f0a83e' } },
        { name: 'ROE', type: 'line', data: ordered.map(function (r) { return r.roejq; }), showSymbol: true, symbolSize: 4, lineStyle: { color: '#4dd0c1', width: 1.4 }, itemStyle: { color: '#4dd0c1' } },
        { name: '资产负债率', type: 'line', data: ordered.map(function (r) { return r.zcfzl; }), showSymbol: true, symbolSize: 4, lineStyle: { color: '#c06ef0', width: 1.4, type: 'dashed' }, itemStyle: { color: '#c06ef0' } }
      ]
    }, true);
    profChart.resize();

    var head = ['报告期', '营业收入', '营收同比', '归母净利', '净利同比', 'ROE'];
    var html = '<thead><tr>' + head.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>';
    records.forEach(function (r) {
      html += '<tr>' + [
        escapeHtml(r.report_date_name || r.report_date),
        money(r.totaloperatereve),
        signed(r.totaloperaterevetz, 1, '%'),
        money(r.parentnetprofit),
        signed(r.parentnetprofittz, 1, '%'),
        r.roejq === null || r.roejq === undefined ? '—' : num(r.roejq) + '%'
      ].map(function (v) { return '<td>' + v + '</td>'; }).join('') + '</tr>';
    });
    $('finTable').innerHTML = html + '</tbody>';
  }

  /* ------------------------------------------------------------ 同业 */

  function renderPeers(payload) {
    var members = payload.members || [];
    var box = $('peerSummary');
    box.innerHTML = '';
    var peer = state.data.overview && state.data.overview.analysis && state.data.overview.analysis.peer;
    box.appendChild(el('h3', 'card__title', '所属板块 · ' + (payload.industry || '—')));
    var grid = el('div', 'metric-grid');
    grid.appendChild(metric('成分股数量', String(members.length)));
    grid.appendChild(metric('PE 中位数', peer && peer.pe_median ? num(peer.pe_median) : '—'));
    grid.appendChild(metric('PB 中位数', peer && peer.pb_median ? num(peer.pb_median) : '—'));
    box.appendChild(grid);
    if (peer && peer.signals && peer.signals.length) {
      box.appendChild(el('div', 'section-title', '相对强弱'));
      peer.signals.forEach(function (s) {
        var row = el('div', 'signal');
        row.appendChild(el('span', 'signal__dot signal__dot--' + (s.level || 'neutral')));
        var body = el('div', 'signal__body');
        body.appendChild(el('div', 'signal__label', s.label));
        body.appendChild(el('div', 'signal__detail', s.detail));
        row.appendChild(body);
        box.appendChild(row);
      });
    }

    $('peerTitle').textContent = '同业对比' + (payload.industry ? '（' + payload.industry + '）' : '');
    var head = ['名称', '现价', '涨跌幅', 'PE(TTM)', 'PB', '总市值'];
    var html = '<thead><tr>' + head.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>';
    members.forEach(function (m) {
      html += '<tr class="' + (m.is_self ? 'is-self' : '') + '">' + [
        escapeHtml(m.name) + '<span class="metric__label"> ' + escapeHtml(m.code) + '</span>',
        num(m.price),
        '<span class="' + trendClass(m.pct_chg) + '">' + signed(m.pct_chg, 2, '%') + '</span>',
        m.pe_ttm === null || m.pe_ttm === undefined ? '—' : num(m.pe_ttm),
        num(m.pb),
        money(m.market_cap)
      ].map(function (v) { return '<td>' + v + '</td>'; }).join('') + '</tr>';
    });
    $('peerTable').innerHTML = html + '</tbody>';
  }

  /* ------------------------------------------------------------ 加载 */

  function loadOverview(force, quiet, hard) {
    if (state.data.overview && !force) { renderOverview(state.data.overview); return Promise.resolve(); }
    var url = '/api/stock/' + state.code + '/overview' + (hard ? '?refresh=1' : '');
    return api(url).then(function (data) {
      state.data.overview = data;
      state.loaded.overview = true;
      state.lastRefresh = Date.now();
      renderOverview(data);
      if (hard) toast('已强制刷新（行情/K线/同业已回源）');
    }).catch(function (err) {
      // 自动刷新失败时不要把整页切成错误态，提示一下即可
      if (!quiet) throw err;
      toast('自动刷新失败：' + (err.message || '未知错误'));
    });
  }

  function loadTrend(force, hard) {
    if (state.data.kline && !force && state.data.kline._key === state.period + state.adjust + state.limit) {
      renderTrend(state.data.kline);
      return Promise.resolve();
    }
    // 多取一段用于均线预热，展示时再截取用户选的区间，保证 MA250 等长周期指标有效
    var fetchCount = Math.min(1500, state.limit + 260);
    var url = '/api/stock/' + state.code + '/kline?period=' + state.period + '&adjust=' + state.adjust +
      '&limit=' + fetchCount + (hard ? '&refresh=1' : '');
    return api(url).then(function (data) {
      var rows = data.rows || [];
      var sliceAt = Math.max(0, rows.length - state.limit);
      var view = {
        rows: rows.slice(sliceAt),
        indicators: {},
        _key: state.period + state.adjust + state.limit
      };
      Object.keys(data.indicators || {}).forEach(function (k) {
        var v = data.indicators[k];
        if (Array.isArray(v)) {
          view.indicators[k] = v.slice(sliceAt);
        } else if (v && typeof v === 'object') {
          var sub = {};
          Object.keys(v).forEach(function (kk) {
            sub[kk] = Array.isArray(v[kk]) ? v[kk].slice(sliceAt) : v[kk];
          });
          view.indicators[k] = sub;
        }
      });
      state.data.kline = view;
      state.loaded.trend = true;
      renderTrend(view);
    });
  }

  function loadFinancial(force) {
    if (state.data.financial && !force) { renderFinancial(state.data.financial); return Promise.resolve(); }
    return api('/api/stock/' + state.code + '/financials?limit=8').then(function (data) {
      state.data.financial = data;
      state.loaded.financial = true;
      renderFinancial(data);
    });
  }

  function loadPeers(force, hard) {
    if (state.data.peers && !force) { renderPeers(state.data.peers); return Promise.resolve(); }
    return api('/api/stock/' + state.code + '/peers' + (hard ? '?refresh=1' : '')).then(function (data) {
      state.data.peers = data;
      state.loaded.peers = true;
      renderPeers(data);
    });
  }

  function loadTab(tab, force, hard) {
    $('stateBlock').hidden = true;
    switchTab(tab, true);
    if (tab === 'home') { loadHome(force, false, hard); return; }
    // 各加载函数参数不同，显式分派，避免把 hard 传错位置（overview 的第二个参数是 quiet）
    var promise;
    if (tab === 'overview') promise = loadOverview(force, false, hard);
    else if (tab === 'trend') promise = loadTrend(force, hard);
    else if (tab === 'peers') promise = loadPeers(force, hard);
    else if (tab === 'financial') promise = loadFinancial(force);
    else return;

    var spinner = $('btnRefresh');
    spinner.classList.add('is-spinning');
    promise.catch(function (err) {
      if (err.unauthorized) {
        showState(err.message);
      } else {
        toast(err.message || '加载失败');
        showState('数据加载失败：' + (err.message || '未知错误'), function () { loadTab(state.tab, true); });
      }
    }).then(function () {
      spinner.classList.remove('is-spinning');
      requestAnimationFrame(resizeCharts);
    });
  }

  function switchTab(tab, silent) {
    state.tab = tab;
    var isHome = tab === 'home';
    Array.prototype.forEach.call(document.querySelectorAll('.tab-panel'), function (p) {
      p.hidden = p.getAttribute('data-panel') !== tab;
    });
    // 二级导航只属于个股页，首页没有
    $('stockTabs').hidden = isHome;
    document.body.classList.toggle('is-stock', !isHome);
    Array.prototype.forEach.call(document.querySelectorAll('.subtabs__item'), function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-tab') === tab);
    });
    // 顶栏随视图切换：首页是"我的自选"，个股页显示股票与收藏按钮
    $('btnSearch').hidden = !isHome;
    $('btnBack').hidden = isHome;
    $('btnStar').hidden = isHome;
    if (isHome) {
      syncHomeHeader();
    } else if (!state.data[tab === 'trend' ? 'kline' : tab]) {
      // 该视图还没有这只股票的数据（刚切股票或刚点刷新）：
      // 先把上一只股票的残留内容换成骨架，避免看到别人的数字
      showSkeleton(tab);
    }
    if (!silent) window.scrollTo({ top: 0, behavior: 'smooth' });
    requestAnimationFrame(resizeCharts);
  }

  function disposeChart(key) {
    if (state.charts[key]) {
      state.charts[key].dispose();
      delete state.charts[key];
    }
  }

  function skeletonLines() {
    return '<div class="skeleton sk-line"></div><div class="skeleton sk-line sk-line--short"></div>';
  }

  function showSkeleton(tab) {
    if (tab === 'overview') {
      $('priceCard').innerHTML = '<div class="skeleton skeleton--xl"></div><div class="skeleton sk-gap"></div>';
      ['scoreCard', 'keyMetrics', 'valuationCard', 'signalCard', 'riskCard'].forEach(function (id) {
        $(id).innerHTML = '<div class="skeleton sk-line"></div><div class="skeleton sk-line"></div>' +
          '<div class="skeleton sk-line sk-line--short"></div>';
      });
    } else if (tab === 'trend') {
      disposeChart('kline');
      $('chartKline').innerHTML = '<div class="skeleton sk-chart"></div>';
      $('techMetrics').innerHTML = skeletonLines();
    } else if (tab === 'financial') {
      disposeChart('revenue');
      disposeChart('profit');
      $('finLatest').innerHTML = skeletonLines();
      $('chartRevenue').innerHTML = '<div class="skeleton sk-chart"></div>';
      $('chartProfitability').innerHTML = '<div class="skeleton sk-chart"></div>';
      $('finTable').innerHTML = '';
    } else if (tab === 'peers') {
      $('peerSummary').innerHTML = skeletonLines();
      $('peerTable').innerHTML = '<tbody><tr><td><div class="skeleton sk-line"></div></td></tr>' +
        '<tr><td><div class="skeleton sk-line"></div></td></tr></tbody>';
    }
  }

  function stockUrl(code, tab) {
    var qs = '?code=' + code;
    if (tab && tab !== 'overview') qs += '&tab=' + tab;
    if (state.token) qs += '&token=' + encodeURIComponent(state.token);
    return qs;
  }

  function enterHome() {
    switchTab('home');
    if (state.homeTab === 'fav') loadHome(false);
    else if (state.homeTab === 'market') loadMarket(false);
    else loadHot(false);
  }

  function syncHomeHeader() {
    var tab = state.homeTab;
    if (tab === 'market') {
      $('stockName').textContent = 'A 股大盘';
      $('stockCode').textContent = state.market && state.market.trade_date ? state.market.trade_date : '';
      return;
    }
    var isHot = tab !== 'fav';
    $('stockName').textContent = isHot ? '今日热门' : '我的自选';
    if (isHot) {
      $('stockCode').textContent = state.hot && state.hot.items ? state.hot.items.length + ' 只' : '';
    } else {
      $('stockCode').textContent = state.home && state.home.count ? state.home.count + ' 只' : '';
    }
  }

  function switchHomeTab(tab, silent) {
    state.homeTab = tab;
    Array.prototype.forEach.call(document.querySelectorAll('.home-tabs__item'), function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-home-tab') === tab);
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-home-panel]'), function (p) {
      p.hidden = p.getAttribute('data-home-panel') !== tab;
    });
    if (state.tab === 'home') syncHomeHeader();
    if (tab === 'hot') loadHot(false);
    else if (tab === 'market') loadMarket(false);
    else loadHome(false);
    if (!silent) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showHome(push) {
    enterHome();
    if (push) history.pushState({ home: true }, '', state.token ? '?token=' + encodeURIComponent(state.token) : '?');
  }

  function enterStock(code, name, tab) {
    if (!name) {
      // 从历史返回时 URL 里没有名称，用已加载的自选或最近查看补上，避免闪一下"加载中…"
      var known = ((state.home && state.home.items) || []).filter(function (i) { return i.code === code; })[0];
      name = known && known.name;
    }
    state.code = code;
    state.data = { overview: null, kline: null, financial: null, peers: null };
    state.isFav = false;
    localStorage.setItem(STORAGE.code, code);
    rememberRecent(code, name);
    $('stockName').textContent = name || code;
    $('stockCode').textContent = code;
    loadTab(tab || 'overview', true);
    // 直接打开走势/财务/同业时没有名称，后台补一次概览（走缓存，很快）拿名称与收藏状态
    if (!name && tab && tab !== 'overview') loadOverview(false, true);
  }

  function openStock(code, name) {
    enterStock(code, name, 'overview');
    history.pushState({ code: code }, '', stockUrl(code, 'overview'));
    closeSearch();
  }

  function updateStar() {
    var btn = $('btnStar');
    if (!btn) return;
    btn.textContent = state.isFav ? '★' : '☆';
    btn.classList.toggle('is-on', !!state.isFav);
    btn.setAttribute('aria-label', state.isFav ? '移出自选' : '加入自选');
  }

  /* ------------------------------------------------------------ 首页：每日热门 */

  function loadHot(force, quiet, hard) {
    if (state.hot && !force) { renderHot(state.hot); return Promise.resolve(); }
    var spinner = $('btnRefresh');
    if (!quiet) spinner.classList.add('is-spinning');
    return api('/api/hot?limit=10' + (hard ? '&refresh=1' : '')).then(function (data) {
      state.hot = data;
      state.lastRefresh = Date.now();
      renderHot(data);
      if (hard) toast('热门榜已强制刷新');
    }).catch(function (err) {
      if (quiet) { toast('热门榜刷新失败：' + (err.message || '未知错误')); return; }
      toast(err.message || '热门榜加载失败');
      showState('热门榜加载失败：' + (err.message || '未知错误'), function () { loadHot(true); });
    }).then(function () {
      spinner.classList.remove('is-spinning');
    });
  }

  function renderHot(payload) {
    var items = payload.items || [];
    var summary = $('hotSummary');
    summary.innerHTML = '';
    var row = el('div', 'home-summary__row');
    row.appendChild(el('div', 'home-summary__count', '今日热门 Top ' + items.length));
    var byAmount = payload.source === 'amount';
    row.appendChild(el('div', 'home-summary__meta',
      (byAmount ? '按成交额排序' : '按东财人气榜') + (payload.stale ? ' · 缓存' : '')));
    summary.appendChild(row);
    summary.appendChild(el('div', 'home-summary__note',
      '点卡片看详情，右上角 ＋ 加入自选 · 榜单每 10 分钟更新'));

    var list = $('hotList');
    list.innerHTML = '';
    if (!items.length) {
      list.appendChild(el('p', 'home-empty', '暂无热门数据，稍后刷新试试。'));
    } else {
      items.forEach(function (item) { list.appendChild(hotCard(item)); });
    }

    $('hotNote').textContent = byAmount
      ? '说明：人气榜暂不可用，当前按全市场成交额排序（成交额越大，通常关注度越高）。'
      : '说明：热度来自东方财富 App 的人气榜，按关注与访问量排序，不是涨幅榜；仅供参考，不构成投资建议。';
    if (state.tab === 'home') syncHomeHeader();
  }

  function hotCard(item) {
    var card = el('div', 'hot-card');
    card.setAttribute('data-code', item.code);
    card.addEventListener('click', function (event) {
      if (event.target.closest('.hot-card__add')) return;
      openStock(item.code, item.name);
    });

    card.appendChild(el('div', 'hot-rank' + (item.rank <= 3 ? ' hot-rank--top' : ''), '#' + item.rank));

    var main = el('div', 'fav-card__main');
    var nameRow = el('div', 'fav-card__name');
    nameRow.appendChild(document.createTextNode(item.name || item.code));
    nameRow.appendChild(el('span', 'fav-card__code', item.code));
    main.appendChild(nameRow);
    var meta = [];
    if (item.amount) meta.push('成交 ' + money(item.amount));
    if (item.turnover !== null && item.turnover !== undefined) meta.push('换手 ' + num(item.turnover) + '%');
    main.appendChild(el('div', 'fav-card__meta', meta.length ? meta.join(' · ') : '—'));
    card.appendChild(main);

    var right = el('div', 'fav-card__right');
    right.appendChild(el('div', 'fav-card__price ' + trendClass(item.pct_chg), num(item.price)));
    right.appendChild(el('div', 'fav-card__pct ' + trendClass(item.pct_chg), signed(item.pct_chg, 2, '%')));
    card.appendChild(right);

    var isFav = !!item.is_favorite;
    var add = el('button', 'hot-card__add' + (isFav ? ' is-added' : ''), isFav ? '✓' : '+');
    add.setAttribute('aria-label', isFav ? '已在自选' : '加入自选');
    add.addEventListener('click', function (event) {
      event.stopPropagation();
      if (item.is_favorite) { toast('已在自选里'); return; }
      addFavorite(item.code, item.name).then(function () {
        item.is_favorite = true;
        add.textContent = '✓';
        add.classList.add('is-added');
      });
    });
    card.appendChild(add);
    return card;
  }

  /* ------------------------------------------------------------ 首页：大盘 */

  function loadMarket(force, quiet, hard) {
    if (state.market && !force) { renderMarket(state.market); return Promise.resolve(); }
    var spinner = $('btnRefresh');
    if (!quiet) spinner.classList.add('is-spinning');
    return api('/api/market' + (hard ? '?refresh=1' : '')).then(function (data) {
      state.market = data;
      state.lastRefresh = Date.now();
      renderMarket(data);
      if (hard) toast('大盘数据已强制刷新');
    }).catch(function (err) {
      if (quiet) { toast('大盘刷新失败：' + (err.message || '未知错误')); return; }
      toast(err.message || '大盘加载失败');
      showState('大盘加载失败：' + (err.message || '未知错误'), function () { loadMarket(true); });
    }).then(function () {
      spinner.classList.remove('is-spinning');
    });
  }

  function renderMarket(payload) {
    var a = payload.analysis || {};
    var ind = a.indicators || {};

    var box = $('marketSummary');
    box.innerHTML = '';
    var top = el('div', 'hero__top');
    var numBox = el('div', 'hero__num-box');
    numBox.appendChild(el('div', 'metric__label', '大盘温度'));
    numBox.innerHTML += '<div class="hero__num' + (a.status_level ? ' hero__num--' + a.status_level : '') + '">' +
      (a.index === null || a.index === undefined ? '—' : num(a.index, 0)) + '<small> / 100</small></div>';
    top.appendChild(numBox);
    var side = el('div', 'hero__side');
    side.appendChild(el('span', 'badge badge--' + (a.status_level || 'neutral'), a.status || '—'));
    side.appendChild(el('div', 'hero__hint', '趋势 50 · 量能 20 · 宽度 30'));
    top.appendChild(side);
    box.appendChild(top);
    if (a.summary) box.appendChild(el('p', 'conclusion', a.summary));

    // 主要指数
    var idx = $('marketIndices');
    idx.innerHTML = '';
    idx.appendChild(el('h3', 'card__title', '主要指数'));
    var grid = el('div', 'index-grid');
    (payload.indices || []).forEach(function (item) {
      var cell = el('div', 'index-cell');
      cell.appendChild(el('div', 'index-cell__name', item.name));
      cell.appendChild(el('div', 'index-cell__price ' + trendClass(item.pct_chg), num(item.price)));
      cell.appendChild(el('div', 'index-cell__pct ' + trendClass(item.pct_chg), signed(item.pct_chg, 2, '%')));
      grid.appendChild(cell);
    });
    idx.appendChild(grid);

    // 趋势与量能
    var trendBox = $('marketTrend');
    trendBox.innerHTML = '';
    trendBox.appendChild(el('h3', 'card__title', '上证指数 · 趋势与量能'));
    var g = el('div', 'metric-grid');
    g.appendChild(metric('现价', num(ind.close)));
    g.appendChild(metric('MA20', num(ind.ma20)));
    g.appendChild(metric('MA60', num(ind.ma60)));
    g.appendChild(metric('MA250', num(ind.ma250)));
    g.appendChild(metric('20 日乖离', signed(ind.bias20, 1, '%')));
    g.appendChild(metric('年线乖离', signed(ind.bias250, 1, '%')));
    g.appendChild(metric('RSI(14)', num(ind.rsi14)));
    g.appendChild(metric('量比 5/20', num(ind.volume_ratio)));
    g.appendChild(metric('一年区间分位',
      ind.range_position && ind.range_position.pct !== null ? num(ind.range_position.pct, 0) + '%' : '—'));
    trendBox.appendChild(g);

    // 宽度
    var breadth = $('marketBreadth');
    breadth.innerHTML = '';
    breadth.appendChild(el('h3', 'card__title', '市场宽度 · 涨跌停'));
    var bg = el('div', 'metric-grid');
    bg.appendChild(metric('涨停', String(payload.limit_up === null || payload.limit_up === undefined ? '—' : payload.limit_up), 'up'));
    bg.appendChild(metric('跌停', String(payload.limit_down === null || payload.limit_down === undefined ? '—' : payload.limit_down), 'down'));
    var ratio = (payload.limit_up !== null && payload.limit_down !== null && payload.limit_down > 0)
      ? (payload.limit_up / payload.limit_down).toFixed(1) + ' : 1' : '—';
    bg.appendChild(metric('涨跌停比', ratio));
    breadth.appendChild(bg);

    // 信号明细
    var sig = $('marketSignals');
    sig.innerHTML = '';
    if ((a.signals || []).length) {
      sig.appendChild(el('h3', 'card__title', '信号明细'));
      a.signals.forEach(function (s) {
        var row = el('div', 'signal');
        row.appendChild(el('span', 'signal__dot signal__dot--' + (s.level || 'neutral')));
        var body = el('div', 'signal__body');
        body.appendChild(el('div', 'signal__label', s.label));
        body.appendChild(el('div', 'signal__detail', s.detail));
        row.appendChild(body);
        sig.appendChild(row);
      });
    }
    if (state.tab === 'home') syncHomeHeader();
  }

  /* ------------------------------------------------------------ 首页：自选列表 */

  function loadHome(force, quiet, hard) {
    if (state.home && !force) { renderHome(state.home); return Promise.resolve(); }
    var spinner = $('btnRefresh');
    if (!quiet) spinner.classList.add('is-spinning');
    return api('/api/favorites' + (hard ? '?refresh=1' : '')).then(function (data) {
      state.home = data;
      state.lastRefresh = Date.now();
      renderHome(data);
      if (hard) toast('已强制刷新');
    }).catch(function (err) {
      if (quiet) {
        toast('自动刷新失败：' + (err.message || '未知错误'));
        return;
      }
      if (err.unauthorized) {
        showState(err.message);
      } else {
        toast(err.message || '自选加载失败');
        showState('自选列表加载失败：' + (err.message || '未知错误'), function () { loadHome(true); });
      }
    }).then(function () {
      spinner.classList.remove('is-spinning');
    });
  }

  function renderHome(payload) {
    var items = payload.items || [];
    state.favCodes = items.map(function (i) { return i.code; });

    var summary = $('homeSummary');
    summary.innerHTML = '';
    var up = items.filter(function (i) { return (i.pct_chg || 0) > 0; }).length;
    var down = items.filter(function (i) { return (i.pct_chg || 0) < 0; }).length;
    var row = el('div', 'home-summary__row');
    row.appendChild(el('div', 'home-summary__count', items.length + ' 只自选'));
    row.appendChild(el('div', 'home-summary__meta', items.length ? ('今日 ' + up + ' 涨 / ' + down + ' 跌') : '还没有自选股'));
    summary.appendChild(row);
    summary.appendChild(el('div', 'home-summary__note', '点卡片看详情，右上角 × 移出 · 盘中每 5 分钟自动刷新'));

    var list = $('favList');
    list.innerHTML = '';
    if (!items.length) {
      list.appendChild(el('p', 'home-empty', '先添加几只关注的股票，首页会显示它们的价格和推荐指数。'));
      if (state.tab === 'home') syncHomeHeader();
      return;
    }
    items.forEach(function (item) { list.appendChild(favCard(item)); });
    if (state.tab === 'home') syncHomeHeader();
  }

  function favCard(item) {
    var card = el('div', 'fav-card');
    card.setAttribute('data-code', item.code);
    card.addEventListener('click', function (event) {
      if (event.target.closest('.fav-card__remove')) return;
      openStock(item.code, item.name);
    });

    var main = el('div', 'fav-card__main');
    var nameRow = el('div', 'fav-card__name');
    nameRow.appendChild(document.createTextNode(item.name || item.code));
    nameRow.appendChild(el('span', 'fav-card__code', item.code));
    main.appendChild(nameRow);
    var meta = [];
    if (item.pe_dynamic !== null && item.pe_dynamic !== undefined) meta.push('PE ' + num(item.pe_dynamic));
    if (item.pb !== null && item.pb !== undefined) meta.push('PB ' + num(item.pb));
    if (item.bias !== null && item.bias !== undefined) {
      meta.push('年线 ' + signed(item.bias, 1, '%'));
    }
    main.appendChild(el('div', 'fav-card__meta', meta.length ? meta.join(' · ') : '数据待更新'));
    card.appendChild(main);

    var right = el('div', 'fav-card__right');
    right.appendChild(el('div', 'fav-card__price ' + trendClass(item.pct_chg), num(item.price)));
    right.appendChild(el('div', 'fav-card__pct ' + trendClass(item.pct_chg), signed(item.pct_chg, 2, '%')));
    card.appendChild(right);

    var score = el('div', 'fav-score' + (item.rating_level ? ' fav-score--' + item.rating_level : ''));
    if (item.index === null || item.index === undefined) {
      score.appendChild(el('span', 'fav-score__num', '—'));
      score.appendChild(el('span', 'fav-score__label', '待更新'));
    } else {
      score.appendChild(el('span', 'fav-score__num', num(item.index, 0)));
      score.appendChild(el('span', 'fav-score__label', item.rating || ''));
    }
    card.appendChild(score);

    var rm = el('button', 'fav-card__remove', '×');
    rm.setAttribute('aria-label', '移出自选');
    rm.addEventListener('click', function (event) {
      event.stopPropagation();
      removeFavorite(item);
    });
    card.appendChild(rm);
    return card;
  }

  function addFavorite(code, name) {
    return api('/api/favorites', 'POST', { code: code }).then(function (data) {
      toast('已加入自选：' + (data.name || name || code));
      if (state.code === code) { state.isFav = true; updateStar(); }
      state.home = null;
      // 只有在看自选列表时才立即重拉；在热门页加自选不需要打断
      if (state.tab === 'home' && state.homeTab === 'fav') loadHome(true);
      return data;
    }).catch(function (err) {
      toast(err.message || '加入失败');
      throw err;
    });
  }

  function removeFavorite(item) {
    var label = item.name || item.code;
    if (!window.confirm('把 ' + label + ' 移出自选？')) return;
    api('/api/favorites/' + item.code, 'DELETE').then(function () {
      toast('已移出 ' + label);
      state.home = null;
      if (state.code === item.code) { state.isFav = false; updateStar(); }
      if (state.tab === 'home' && state.homeTab === 'fav') loadHome(true);
    }).catch(function (err) {
      toast(err.message || '移出失败');
    });
  }

  /* ------------------------------------------------------------ 自动刷新 */

  // 只在 A 股交易时段、且页面可见时自动刷新。间隔 5 分钟：
  // 行情服务端缓存是 60 秒，5 分钟足够看到变化，又不会给这台 1 核机器和数据源添压力。
  var AUTO_REFRESH_MS = 5 * 60 * 1000;
  var AUTO_CHECK_MS = 30 * 1000;

  function isTradingTime() {
    var now = new Date();
    var bj = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);  // 换算成北京时间
    var day = bj.getDay();
    if (day === 0 || day === 6) return false;
    var minutes = bj.getHours() * 60 + bj.getMinutes();
    return (minutes >= 570 && minutes <= 690) || (minutes >= 780 && minutes <= 900);  // 9:30-11:30, 13:00-15:00
  }

  function refreshCurrent(quiet, hard) {
    if (state.tab === 'home') {
      if (state.homeTab === 'hot') return loadHot(true, quiet, hard);
      if (state.homeTab === 'market') return loadMarket(true, quiet, hard);
      return loadHome(true, quiet, hard);
    }
    if (state.tab === 'overview') return loadOverview(true, quiet, hard);
    // 走势/财务/同业的数据变化慢，重绘还会丢掉图表的缩放状态，自动刷新时交给手动
    return Promise.resolve();
  }

  function autoRefreshCheck() {
    if (document.hidden) return;
    if (!isTradingTime()) return;
    if (Date.now() - (state.lastRefresh || 0) < AUTO_REFRESH_MS) return;
    refreshCurrent(true);
  }

  function startAutoRefresh() {
    setInterval(autoRefreshCheck, AUTO_CHECK_MS);
    // 从后台切回来时立刻补一次（若已超过间隔）
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) autoRefreshCheck();
    });
  }

  /* ------------------------------------------------------------ 搜索与最近查看 */

  function rememberRecent(code, name) {
    var list = [];
    try { list = JSON.parse(localStorage.getItem(STORAGE.recent) || '[]'); } catch (e) { list = []; }
    list = list.filter(function (item) { return item.code !== code; });
    list.unshift({ code: code, name: name || code });
    localStorage.setItem(STORAGE.recent, JSON.stringify(list.slice(0, 6)));
  }

  function renderRecents() {
    var list = [];
    try { list = JSON.parse(localStorage.getItem(STORAGE.recent) || '[]'); } catch (e) { list = []; }
    var node = $('recentList');
    node.innerHTML = '';
    list.forEach(function (item) {
      var li = el('li');
      var left = el('div');
      left.innerHTML = '<span class="r-name">' + escapeHtml(item.name) + '</span><span class="r-code">' + escapeHtml(item.code) + '</span>';
      li.appendChild(left);
      li.appendChild(el('span', 'r-market', '查看'));
      li.addEventListener('click', function () { openStock(item.code, item.name); });
      node.appendChild(li);
    });
  }

  function searchRow(item) {
    var li = el('li');
    var left = el('div');
    left.innerHTML = '<span class="r-name">' + escapeHtml(item.name) + '</span><span class="r-code">' + escapeHtml(item.code) + '</span>';
    li.appendChild(left);

    var actions = el('div', 'r-actions');
    var isFav = state.favCodes.indexOf(item.code) >= 0;
    var addBtn = el('button', 'r-add' + (isFav ? ' is-added' : ''), isFav ? '已加' : '＋');
    addBtn.setAttribute('aria-label', '加入自选');
    addBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      if (isFav) { toast('已在自选里'); return; }
      addFavorite(item.code, item.name).then(function () { renderRecents(); });
      addBtn.textContent = '已加';
      addBtn.classList.add('is-added');
    });
    actions.appendChild(addBtn);
    actions.appendChild(el('span', 'r-market', item.market || ''));
    li.appendChild(actions);

    li.addEventListener('click', function () { openStock(item.code, item.name); });
    return li;
  }

  function openSearch() {
    $('searchLayer').hidden = false;
    renderRecents();
    setTimeout(function () { $('searchInput').focus(); }, 50);
  }

  function closeSearch() {
    $('searchLayer').hidden = true;
    $('searchInput').value = '';
    $('searchResults').innerHTML = '';
  }

  function doSearch(keyword) {
    var node = $('searchResults');
    if (!keyword) { node.innerHTML = ''; return; }
    api('/api/search?q=' + encodeURIComponent(keyword) + '&count=8').then(function (list) {
      node.innerHTML = '';
      if (!list.length) { node.appendChild(el('li', null, '未找到匹配的股票')); return; }
      list.forEach(function (item) { node.appendChild(searchRow(item)); });
    }).catch(function (err) { toast(err.message || '搜索失败'); });
  }

  /* ------------------------------------------------------------ 图表尺寸 */

  function resizeCharts() {
    Object.keys(state.charts).forEach(function (k) {
      if (state.charts[k]) state.charts[k].resize();
    });
  }

  /* ------------------------------------------------------------ 初始化 */

  function bindSeg(id, onChange) {
    var box = $(id);
    box.addEventListener('click', function (event) {
      var btn = event.target.closest('.seg__item');
      if (!btn) return;
      Array.prototype.forEach.call(box.querySelectorAll('.seg__item'), function (b) {
        b.classList.toggle('is-active', b === btn);
      });
      onChange(btn.getAttribute('data-value'));
    });
  }

  function routeFromUrl() {
    var params = new URLSearchParams(location.search);
    var code = params.get('code');
    if (code) { enterStock(code, null, params.get('tab') || 'overview'); }
    else { enterHome(); }
  }

  function init() {
    var params = new URLSearchParams(location.search);
    state.token = params.get('token') || localStorage.getItem(STORAGE.token) || '';
    if (state.token) localStorage.setItem(STORAGE.token, state.token);

    // 个股页的二级标签：切换视图并把 tab 记进 URL，刷新/前进后退都能回到同一视图
    Array.prototype.forEach.call(document.querySelectorAll('.subtabs__item'), function (btn) {
      btn.addEventListener('click', function () {
        var tab = btn.getAttribute('data-tab');
        if (!state.code) return;
        loadTab(tab);
        history.replaceState({ code: state.code, tab: tab }, '', stockUrl(state.code, tab));
      });
    });

    bindSeg('segPeriod', function (value) { state.period = value; loadTrend(true); });
    bindSeg('segAdjust', function (value) { state.adjust = parseInt(value, 10); loadTrend(true); });
    bindSeg('segRange', function (value) { state.limit = parseInt(value, 10); loadTrend(true); });

    $('btnRefresh').addEventListener('click', function () {
      // 手动刷新一律强制回源，绕开服务端缓存
      if (state.tab === 'home') {
        if (state.homeTab === 'hot') loadHot(true, false, true);
        else if (state.homeTab === 'market') loadMarket(true, false, true);
        else loadHome(true, false, true);
        return;
      }
      Object.keys(state.data).forEach(function (k) { state.data[k] = null; });
      loadTab(state.tab, true, true);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.home-tabs__item'), function (btn) {
      btn.addEventListener('click', function () {
        switchHomeTab(btn.getAttribute('data-home-tab'));
      });
    });
    $('btnSearch').addEventListener('click', openSearch);
    $('btnSearchCancel').addEventListener('click', closeSearch);
    $('btnBack').addEventListener('click', function () { showHome(true); });
    $('btnAddFavorite').addEventListener('click', function () {
      $('searchHint').textContent = '点结果右侧的 ＋ 加入自选，点名称直接查看';
      openSearch();
    });
    $('btnStar').addEventListener('click', function () {
      if (!state.code) return;
      if (state.isFav) {
        removeFavorite({ code: state.code, name: $('stockName').textContent });
      } else {
        addFavorite(state.code);
      }
    });

    var timer = null;
    $('searchInput').addEventListener('input', function (event) {
      var value = event.target.value.trim();
      clearTimeout(timer);
      timer = setTimeout(function () { doSearch(value); }, 260);
    });
    $('searchInput').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        clearTimeout(timer);
        var value = event.target.value.trim();
        if (/^\d{6}$/.test(value)) openStock(value, null); else doSearch(value);
      }
    });

    window.addEventListener('resize', resizeCharts);
    window.addEventListener('orientationchange', function () { setTimeout(resizeCharts, 250); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) resizeCharts(); });
    window.addEventListener('popstate', routeFromUrl);
    startAutoRefresh();

    if (params.get('code')) {
      enterStock(params.get('code'), null, params.get('tab') || 'overview');
    } else {
      enterHome();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
