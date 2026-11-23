/**
 * API-HUB · Client 半
 *
 *   sidebar.panellist  id="apihub"  order=12  → 左侧栏「自动化任务」下面、「我的能力中心」上面
 *   main               key="apihub"          → 中央面板
 *
 * 面板里就一个 iframe，装的是 web/index.html 那份单网页本身 —— 单开浏览器和
 * 装在这里跑的是同一份文件、同一套逻辑，只靠 ?host=1 切到「本机代理 + 本机 JSON」。
 * 深浅色从宿主的 --dsw-* 令牌探出来，用 postMessage 同步给页面。
 */
window.__ModuleLoader__.load({
  id: 'dsh-api-hub',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'apihub'
    const NS = 'apihub'
    const PAGE_URL = '/api-hub/?host=1'

    const dictZh = {
      panel: 'API-HUB',
      title: 'API-HUB',
    }

    const dictEn = {
      panel: 'API-HUB',
      title: 'API-HUB',
    }

    /* 左侧栏图标：一个插头 —— 「通不通」一眼看得出来 */
    function HubIcon({ size = 20 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M9 3.4v3.6M15 3.4v3.6', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('path', {
          d: 'M7 7h10v3.5a5 5 0 0 1-10 0V7Z',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M12 15.5V20.6', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('path', { d: 'M9.6 20.6h4.8', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
      )
    }

    /** 从宿主令牌亮度判深浅色，跟随主题切换。 */
    function useHostTheme() {
      const [dark, setDark] = React.useState(false)
      React.useEffect(() => {
        let alive = true
        const probe = () => {
          if (!alive) return
          const el = document.body
          const cs = getComputedStyle(el)
          const raw = (cs.getPropertyValue('--dsw-alias-bg-base') || cs.backgroundColor || '').trim()
          const hex = /^#([0-9a-f]{6})$/i.exec(raw)
          const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(raw)
          let value
          if (hex) {
            const n = parseInt(hex[1], 16)
            value = (((n >> 16) & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000
          } else if (rgb) {
            value = (Number(rgb[1]) * 299 + Number(rgb[2]) * 587 + Number(rgb[3]) * 114) / 1000
          }
          setDark(value === undefined ? window.matchMedia('(prefers-color-scheme: dark)').matches : value < 128)
        }
        probe()
        const observer = new MutationObserver(probe)
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
        const media = window.matchMedia('(prefers-color-scheme: dark)')
        media.addEventListener('change', probe)
        return () => {
          alive = false
          observer.disconnect()
          media.removeEventListener('change', probe)
        }
      }, [])
      return dark
    }

    function HubPanel() {
      const frameRef = React.useRef(null)
      const dark = useHostTheme()

      const postTheme = React.useCallback(() => {
        const frame = frameRef.current
        if (!frame || !frame.contentWindow) return
        try {
          frame.contentWindow.postMessage({ type: 'apihub:theme', theme: dark ? 'dark' : 'light' }, '*')
        } catch {
          /* 忽略 */
        }
      }, [dark])

      React.useEffect(() => {
        postTheme()
      }, [postTheme])

      React.useEffect(() => {
        const onMessage = (event) => {
          const data = event.data
          if (data && typeof data === 'object' && data.type === 'apihub:ready') postTheme()
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [postTheme])

      return h(
        'div',
        { className: 'ah-root' },
        h('style', null, CSS),
        h('iframe', {
          ref: frameRef,
          className: 'ah-frame',
          src: PAGE_URL,
          title: 'API-HUB',
          allow: 'clipboard-write',
          onLoad: postTheme,
        }),
      )
    }

    const CSS = [
      '.ah-root{display:flex;flex-direction:column;height:100%;min-height:0;width:100%;overflow:hidden}',
      '.ah-frame{flex:1;width:100%;min-height:0;border:0;display:block;background:transparent;color-scheme:light dark}',
    ].join('')

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const disposers = [
            ctx.locale.register(NS, 'zh', dictZh),
            ctx.locale.register(NS, 'zh-CN', dictZh),
            ctx.locale.register(NS, 'en', dictEn),
            ctx.locale.register(NS, 'en-US', dictEn),
          ]
          return () => {
            for (const dispose of disposers) dispose()
          }
        }, 'API-HUB: dictionaries')

        const t = ctx.locale.bind(NS)

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 12, label: () => t('panel'), locale: NS },
            HubIcon,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, () => h(HubPanel, { t })),
        )
      },
    }
  },
})
