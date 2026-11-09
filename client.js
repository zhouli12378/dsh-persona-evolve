/**
 * dsh-persona-evolve —— 浏览器半边（设置页一页「人设会自己长大」）
 *
 * 只做三件事：看状态、改配置、手动跑一次（可先预览不写盘）。
 * 所有数据都来自宿主 /api/persona-evolve/*，面板不假装知道任何事。
 */
window.__ModuleLoader__.load({
  id: 'dsh-persona-evolve',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const API = '/api/persona-evolve';
    const BUILD = 1;

    const asJson = async (res) => {
      if (res.ok) return res.json();
      throw new Error('HTTP ' + res.status);
    };
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }));
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }));

    const CSS = `
      .pe-wrap { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 18px; }
      .pe-card { border: 1px solid rgba(127,127,127,.22); border-radius: 12px; padding: 14px 16px; }
      .pe-title { font-weight: 600; margin: 0 0 10px; font-size: 15px; }
      .pe-row { display: flex; align-items: center; gap: 10px; margin: 8px 0; flex-wrap: wrap; }
      .pe-label { min-width: 132px; opacity: .86; font-size: 13px; }
      .pe-input { flex: 1; min-width: 220px; padding: 6px 9px; border-radius: 8px;
                  border: 1px solid rgba(127,127,127,.34); background: transparent; color: inherit; font: inherit; }
      .pe-btn { padding: 6px 14px; border-radius: 8px; border: 1px solid rgba(127,127,127,.34);
                background: rgba(127,127,127,.10); color: inherit; font: inherit; cursor: pointer; }
      .pe-btn[disabled] { opacity: .5; cursor: default; }
      .pe-btn.primary { background: rgba(80,140,255,.18); border-color: rgba(80,140,255,.45); }
      .pe-note { font-size: 12px; opacity: .66; line-height: 1.6; }
      .pe-err { color: #e06c75; font-size: 13px; white-space: pre-wrap; }
      .pe-ok { color: #67c07a; font-size: 13px; white-space: pre-wrap; }
      .pe-pre { font-size: 12px; white-space: pre-wrap; background: rgba(127,127,127,.08);
                border-radius: 8px; padding: 10px; max-height: 240px; overflow: auto; }
    `;

    function Field({ label, children, note }) {
      return h('div', { className: 'pe-row' },
        h('span', { className: 'pe-label' }, label),
        children,
        note ? h('span', { className: 'pe-note' }, note) : null);
    }

    function Panel() {
      const [st, setSt] = React.useState(null);
      const [form, setForm] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [err, setErr] = React.useState('');
      const [msg, setMsg] = React.useState('');
      const [preview, setPreview] = React.useState(null);

      const applyState = (s) => {
        setSt(s);
        setForm({
          enabled: s.enabled,
          intervalHours: s.intervalHours,
          personaFile: s.personaFile,
          section: s.section,
          maxLines: s.maxLines,
          baseUrl: s.baseUrl,
          model: s.model,
          apiKey: '',
        });
      };

      React.useEffect(() => {
        jget('/status').then(applyState).catch((e) => setErr('读状态失败：' + e.message));
      }, []);

      const set = (k) => (ev) => setForm((f) => ({ ...f, [k]: ev.target.value }));

      const save = async () => {
        setBusy('save'); setErr(''); setMsg('');
        try {
          const body = { ...form };
          if (!body.apiKey) body.apiKey = '__KEEP__';   // 留空 = 不改动已存的 key
          const s = await jpost('/config', body);
          applyState(s);
          setMsg('已保存。' + (s.configured ? '' : '（还没有可用的模型通道，见下方说明）'));
        } catch (e) { setErr('保存失败：' + e.message); }
        setBusy('');
      };

      const run = async (dryRun) => {
        setBusy(dryRun ? 'dry' : 'run'); setErr(''); setMsg(''); setPreview(null);
        try {
          const r = await jpost('/run', { dryRun });
          setPreview(r);
          setMsg(dryRun
            ? (r.changed ? '预览：会改成下面这样（没有写盘）' : '预览：不会改动（' + (r.reason || '') + '）')
            : (r.changed ? '已更新人设里那一节' : '没有改动（' + (r.reason || '') + '）'));
          const s = await jget('/status');
          applyState(s);
        } catch (e) { setErr('运行失败：' + e.message); }
        setBusy('');
      };

      if (!st || !form) return h('div', { className: 'pe-wrap' }, h('p', { className: 'pe-note' }, err || '加载中…'));

      const channel = st.configured
        ? (st.via && st.via.startsWith('host') ? '使用宿主自带的模型服务（不额外花钱）' : '使用你自己填的 key')
        : '没有可用的模型通道';

      return h('div', { className: 'pe-wrap' },
        h('div', { className: 'pe-card' },
          h('p', { className: 'pe-title' }, '人设会自己长大'),
          h('p', { className: 'pe-note' },
            '定期回看最近的聊天，只更新人设文件里「' + st.section + '」那一节的条目；铁律与边界永远不动，写盘前自动备份。'),
          h('p', { className: 'pe-note' },
            '当前通道：' + channel
            + (st.via ? '（' + st.via + '）' : '')
            + ' · 上次自省：' + (st.lastRun ? new Date(st.lastRun).toLocaleString() : '还没跑过')
            + (st.lastReason ? '（' + st.lastReason + '）' : ''))),

        h('div', { className: 'pe-card' },
          h('p', { className: 'pe-title' }, '基本设置'),
          h(Field, { label: '启用' },
            h('select', { className: 'pe-input', value: String(form.enabled), onChange: (e) => setForm((f) => ({ ...f, enabled: e.target.value === 'true' })) },
              h('option', { value: 'true' }, '开启'),
              h('option', { value: 'false' }, '关闭'))),
          h(Field, { label: '多久一次（小时）' },
            h('input', { className: 'pe-input', type: 'number', min: 1, value: form.intervalHours, onChange: set('intervalHours') }),
            h('span', { className: 'pe-note' }, '168 = 一周')),
          h(Field, { label: '人设文件' },
            h('input', { className: 'pe-input', value: form.personaFile, onChange: set('personaFile') }),
            h('span', { className: 'pe-note' }, st.personaFileExists ? '文件存在' : '⚠️ 这个路径下没有文件')),
          h(Field, { label: '可演化小节标题' },
            h('input', { className: 'pe-input', value: form.section, onChange: set('section') }),
            h('span', { className: 'pe-note' }, '人设里以 ## 开头的那一节')),
          h(Field, { label: '最多几条' },
            h('input', { className: 'pe-input', type: 'number', min: 1, max: 30, value: form.maxLines, onChange: set('maxLines') }))),

        h('div', { className: 'pe-card' },
          h('p', { className: 'pe-title' }, '模型（通常不用管）'),
          h('p', { className: 'pe-note' }, '宿主有自带模型服务时，下面这些会被忽略；只有在面板提示"没有可用的模型通道"时才需要填写。'),
          h(Field, { label: 'API Key' },
            h('input', {
              className: 'pe-input', type: 'password', autocomplete: 'off',
              placeholder: st.hasApiKey ? '已保存（' + st.apiKeyMasked + '），留空表示不改' : 'sk-…',
              value: form.apiKey, onChange: set('apiKey'),
            })),
          h(Field, { label: '接口地址' },
            h('input', { className: 'pe-input', value: form.baseUrl, onChange: set('baseUrl') })),
          h(Field, { label: '模型名' },
            h('input', { className: 'pe-input', value: form.model, onChange: set('model') }))),

        h('div', { className: 'pe-row' },
          h('button', { className: 'pe-btn primary', disabled: !!busy, onClick: save }, busy === 'save' ? '保存中…' : '保存'),
          h('button', { className: 'pe-btn', disabled: !!busy, onClick: () => run(true) }, busy === 'dry' ? '预览中…' : '先预览（不写盘）'),
          h('button', { className: 'pe-btn', disabled: !!busy, onClick: () => run(false) }, busy === 'run' ? '自省中…' : '现在自省一次')),

        err ? h('p', { className: 'pe-err' }, err) : null,
        msg ? h('p', { className: 'pe-ok' }, msg) : null,

        preview ? h('div', { className: 'pe-card' },
          h('p', { className: 'pe-title' }, '结果'),
          h('p', { className: 'pe-note' }, '原因：' + (preview.reason || '—')),
          h('p', { className: 'pe-note' }, '改动前：'),
          h('pre', { className: 'pe-pre' }, preview.before || '（空）'),
          h('p', { className: 'pe-note' }, '改动后：'),
          h('pre', { className: 'pe-pre' }, preview.after || '（空）')) : null,

        h('p', { className: 'pe-note' },
          '数据目录：' + (st.dataDir || '?') + '（这是开机级设置，改 profile 的 cordis.patch.yml 里的 dataDir）'),
        h('p', { className: 'pe-note' },
          '配置：' + st.configFile + ' · 日志：' + st.logFile + ' · 面板 v' + BUILD));
    }

    class Boundary extends React.Component {
      constructor(p) { super(p); this.state = { err: '' }; }
      static getDerivedStateFromError(e) { return { err: String(e && e.message ? e.message : e) }; }
      render() {
        if (this.state.err) {
          return h('div', { className: 'pe-wrap' },
            h('p', { className: 'pe-err' }, '这页出错了：' + this.state.err),
            h('button', { className: 'pe-btn', onClick: () => this.setState({ err: '' }) }, '重试'));
        }
        return this.props.children;
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style');
        style.setAttribute('data-plugin-css', 'dsh-persona-evolve');
        style.textContent = CSS;
        document.head.appendChild(style);
        if (typeof ctx.effect === 'function') ctx.effect(() => () => style.remove(), 'dsh-persona-evolve: 设置页样式');

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots;
        if (!slots) return;
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'persona-evolve', order: 46, label: '人设会自己长大' },
          () => h(Boundary, null, h(Panel)),
        ));
      },
    };
  },
});
