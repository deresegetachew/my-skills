// Light or dark (#450): the page follows the system's setting until the owner picks one with the switch, kept in the
// browser under THEME_KEY. No React here, so tests/web_ui_theme.test.ts runs it as it is.

export type ThemeChoice = "system" | "light" | "dark";

export const THEME_KEY = "factory-ui-theme";

const CHOICES: ThemeChoice[] = ["system", "light", "dark"];

/** The choice a kept value is: system for none or one it doesn't know. */
export function choiceOf(kept: string | null): ThemeChoice {
  return CHOICES.includes(kept as ThemeChoice) ? (kept as ThemeChoice) : "system";
}

/** The theme the page shows for the kept choice, when the system is dark or not. */
export function themeOf(kept: string | null, systemDark: boolean): "light" | "dark" {
  const c = choiceOf(kept);
  return c === "system" ? (systemDark ? "dark" : "light") : c;
}

/** What one press of the switch picks next: system, light, dark, and back. */
export function nextTheme(kept: string | null): ThemeChoice {
  return CHOICES[(CHOICES.indexOf(choiceOf(kept)) + 1) % CHOICES.length] as ThemeChoice;
}

export function themeLabel(kept: string | null): string {
  const c = choiceOf(kept);
  return c === "system" ? "Theme: follows the system" : `Theme: ${c}`;
}
