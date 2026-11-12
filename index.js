// dsh-plugin-account-sync — host entry.
//
// Syncs what a DeepSeek Harness terminal needs in order to reproduce another
// terminal signed into the same account: installed plugins + enablement, app
// settings, selected workspace files, session logs and skills / agent presets.
// The browser half (client.js) renders the settings page and calls the JSON API
// registered below.
import { createEngine } from './lib/engine.js'

export const name = 'account-sync'

export function apply(ctx) {
  const engine = createEngine(ctx)

  // The engine owns a background auto-sync timer and an optional LAN listener.
  ctx.effect(() => {
    engine.start()
    return () => engine.stop()
  })

  // Same-origin JSON API for the settings page. Only registered once the web
  // server exists, so the section simply stays inert in headless profiles.
  ctx.inject(['webServer'], (web) => {
    web.effect(() => engine.serve(web.webServer))
  })
}
