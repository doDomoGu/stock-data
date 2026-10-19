/* 股票分析看板前端：原生 JS + ECharts，按移动端交互设计。 */
(function () {
  'use strict';

  var STORAGE = { code: 'stockTool.code', token: 'stockTool.token', recent: 'stockTool.recent' };

  var state = {
    code: '',
    token: '',
    tab: 'overview',
    period: 'day',
    adjust: 1,
    limit: 250,
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

  function api(path) {
    var url = BASE_PATH + String(path).replace(/^\//, '');
    if (state.token) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(state.token);
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (res) {
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

    // 评分卡
    var scoreCard = $('scoreCard');
    scoreCard.innerHTML = '';
    var head = el('div', 'score-head');
    var scoreBox = el('div');
    scoreBox.appendChild(el('div', 'metric__label', '规则化综合评分'));
    scoreBox.innerHTML += '<div class="score-value">' + num(a.total_score, 1) + '<small> / ' + (a.max_score || 100) + '</small></div>';
    head.appendChild(scoreBox);
    head.appendChild(el('span', 'badge badge--' + (a.rating_level || 'neutral'), a.rating || '—'));
    scoreCard.appendChild(head);

    var dims = a.dimensions || {};
    var names = { trend: '技术面', valuation: '估值', financial: '财务', peer: '同业' };
    var dimList = el('div', 'dim-list');
    Object.keys(names).forEach(function (key) {
      var d = dims[key] || {};
      var score = d.score === null || d.score === undefined ? null : Number(d.score);
      var max = d.max || 0;
      var ratio = score === null || !max ? 0 : Math.max(0, Math.min(1, score / max));
      var row = el('div', 'dim');
      row.appendChild(el('span', null, names[key]));
      var bar = el('div', 'dim__bar');
      var fill = el('div', 'dim__fill' + (ratio >= 0.65 ? ' dim__fill--good' : ratio < 0.4 ? ' dim__fill--bad' : ''));
      fill.style.width = (ratio * 100).toFixed(0) + '%';
      bar.appendChild(fill);
      row.appendChild(bar);
      row.appendChild(el('span', 'dim__val', score === null ? '无数据' : num(score, 1) + '/' + max));
      dimList.appendChild(row);
    });
    scoreCard.appendChild(dimList);

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

  function loadOverview(force) {
    if (state.data.overview && !force) { renderOverview(state.data.overview); return Promise.resolve(); }
    return api('/api/stock/' + state.code + '/overview').then(function (data) {
      state.data.overview = data;
      state.loaded.overview = true;
      renderOverview(data);
      if (state.tab !== 'overview') loadTab(state.tab, force);
    });
  }

  function loadTrend(force) {
    if (state.data.kline && !force && state.data.kline._key === state.period + state.adjust + state.limit) {
      renderTrend(state.data.kline);
      return Promise.resolve();
    }
    // 多取一段用于均线预热，展示时再截取用户选的区间，保证 MA250 等长周期指标有效
    var fetchCount = Math.min(1500, state.limit + 260);
    var url = '/api/stock/' + state.code + '/kline?period=' + state.period + '&adjust=' + state.adjust + '&limit=' + fetchCount;
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

  function loadPeers(force) {
    if (state.data.peers && !force) { renderPeers(state.data.peers); return Promise.resolve(); }
    return api('/api/stock/' + state.code + '/peers').then(function (data) {
      state.data.peers = data;
      state.loaded.peers = true;
      renderPeers(data);
    });
  }

  function loadTab(tab, force) {
    $('stateBlock').hidden = true;
    switchTab(tab, true);
    var loader = { overview: loadOverview, trend: loadTrend, financial: loadFinancial, peers: loadPeers }[tab];
    if (!loader) return;
    var spinner = $('btnRefresh');
    spinner.classList.add('is-spinning');
    loader(force).catch(function (err) {
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
    Array.prototype.forEach.call(document.querySelectorAll('.tab-panel'), function (p) {
      p.hidden = p.getAttribute('data-panel') !== tab;
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tabbar__item'), function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-tab') === tab);
    });
    if (!silent) window.scrollTo({ top: 0, behavior: 'smooth' });
    requestAnimationFrame(resizeCharts);
  }

  function selectStock(code, name) {
    state.code = code;
    state.data = { overview: null, kline: null, financial: null, peers: null };
    localStorage.setItem(STORAGE.code, code);
    rememberRecent(code, name);
    history.replaceState(null, '', '?code=' + code + (state.token ? '&token=' + encodeURIComponent(state.token) : ''));
    $('stockName').textContent = name || '加载中…';
    $('stockCode').textContent = code;
    closeSearch();
    loadTab('overview', true);
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
      li.addEventListener('click', function () { selectStock(item.code, item.name); });
      node.appendChild(li);
    });
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
      list.forEach(function (item) {
        var li = el('li');
        var left = el('div');
        left.innerHTML = '<span class="r-name">' + escapeHtml(item.name) + '</span><span class="r-code">' + escapeHtml(item.code) + '</span>';
        li.appendChild(left);
        li.appendChild(el('span', 'r-market', item.market || ''));
        li.addEventListener('click', function () { selectStock(item.code, item.name); });
        node.appendChild(li);
      });
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

  function init() {
    var params = new URLSearchParams(location.search);
    state.token = params.get('token') || localStorage.getItem(STORAGE.token) || '';
    if (state.token) localStorage.setItem(STORAGE.token, state.token);
    state.code = params.get('code') || localStorage.getItem(STORAGE.code) || '601021';
    $('stockCode').textContent = state.code;
    history.replaceState(null, '', '?code=' + state.code + (state.token ? '&token=' + encodeURIComponent(state.token) : ''));

    Array.prototype.forEach.call(document.querySelectorAll('.tabbar__item'), function (btn) {
      btn.addEventListener('click', function () { loadTab(btn.getAttribute('data-tab')); });
    });

    bindSeg('segPeriod', function (value) { state.period = value; loadTrend(true); });
    bindSeg('segAdjust', function (value) { state.adjust = parseInt(value, 10); loadTrend(true); });
    bindSeg('segRange', function (value) { state.limit = parseInt(value, 10); loadTrend(true); });

    $('btnRefresh').addEventListener('click', function () {
      Object.keys(state.data).forEach(function (k) { state.data[k] = null; });
      loadTab(state.tab, true);
    });
    $('btnSearch').addEventListener('click', openSearch);
    $('btnSearchCancel').addEventListener('click', closeSearch);

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
        if (/^\d{6}$/.test(value)) selectStock(value, null); else doSearch(value);
      }
    });

    window.addEventListener('resize', resizeCharts);
    window.addEventListener('orientationchange', function () { setTimeout(resizeCharts, 250); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) resizeCharts(); });

    switchTab('overview', true);
    loadTab('overview', true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
