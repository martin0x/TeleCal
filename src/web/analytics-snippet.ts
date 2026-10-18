// src/web/analytics-snippet.ts
// The browser side of PostHog for TeleCal's web pages. Values are written
// into an inline script, so they are JSON-encoded with "<" escaped: nothing in
// the config can close the <script> tag.

export interface WebAnalyticsConfig {
  apiKey: string
  host: string
  environment: string
}

// PostHog's official loader, verbatim from https://posthog.com/docs/libraries/js.
// It defines a queueing stub and loads array.js from the -assets host.
const LOADER = `!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],Object.defineProperty(u,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e}}),Object.defineProperty(u.people,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(){return u.toString(1)+".people (stub)"}}),o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagResult isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);`

function js(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c")
}

/**
 * Cookieless (in-memory) PostHog with every automatic capture off. Callers
 * add their own events after it. Anonymous visitors get no person profile.
 */
export function postHogInit(config: WebAnalyticsConfig): string {
  const options = {
    api_host: config.host,
    persistence: "memory",
    person_profiles: "identified_only",
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    capture_performance: false,
    capture_exceptions: false,
    rageclick: false,
    disable_session_recording: true,
    disable_surveys: true,
  }
  return (
    `${LOADER}\n` +
    `posthog.init(${js(config.apiKey)}, ${js(options)})\n` +
    `posthog.register(${js({ environment: config.environment })})\n`
  )
}

/** The landing page: a page view, and which Request access button was tapped. */
export function landingAnalyticsScript(config: WebAnalyticsConfig | undefined): string {
  if (!config?.apiKey) return ""
  return (
    "<script>\n" +
    postHogInit(config) +
    'posthog.capture("$pageview")\n' +
    'document.querySelectorAll("[data-cta]").forEach(function (link) {\n' +
    '  link.addEventListener("click", function () {\n' +
    "    // sendBeacon survives the navigation to t.me that follows the click.\n" +
    '    posthog.capture("landing_cta_clicked", { placement: link.getAttribute("data-cta") }, { transport: "sendBeacon" })\n' +
    "  })\n" +
    "})\n" +
    "</script>"
  )
}
