// The theme is one of three states: follow the system, or the visitor's own choice of light or dark. A choice is kept in
// localStorage and applied as data-theme on <html>; "system" is the absence of the attribute, so the stylesheet's
// prefers-color-scheme rule decides.

export type Theme = "system" | "light" | "dark"

export const THEME_STORAGE_KEY = "accufi-theme"

export const THEME_LABEL: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" }

/** Anything that is not a recognised choice means no choice was made. */
export function parseTheme(raw: string | null | undefined): Theme {
  return raw === "light" || raw === "dark" ? raw : "system"
}

/** The order the toggle cycles through. */
export function nextTheme(theme: Theme): Theme {
  return theme === "system" ? "light" : theme === "light" ? "dark" : "system"
}

// Runs inline in <head>, before the first paint, so a visitor who chose dark never sees a flash of light while the app
// loads. It must not throw (storage can be blocked) and must only ever set a value it has checked. It is a fixed string with
// no input from anyone, which is why injecting it as markup is safe.
export const THEME_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`
