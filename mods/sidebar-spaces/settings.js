// Keep this file identical in both mod folders so each can open the dialog.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, setShared, shared } from "herdr";
import {
  STATUS_POSITION_KEY, SHOW_USAGE, SHOW_PORTS, SHOW_CUP, EXPAND_TERMINALS,
  SHOW_GIT_BRANCH, SHOW_GIT_CHANGES, SHOW_GIT_SYNC, EXPAND_CHILDREN, AGENT_SORT, UNREAD_CLEAR, UNREAD_COLOR, UNREAD_COLORS, enabled,
} from "./shared.js";

export function settingsButton(t, openSettings, cursorStyle = "cursor_pointer") {
  return div().id("sidebar-settings").size(26).flex_none().flex().items_center().justify_center()
    .rounded(6)[cursorStyle]().hover(s => s.bg(t.hover)).tooltip("Sidebar settings")
    .on_click(openSettings)
    .child(svg("mods/workspace-chrome/settings.svg").size(14));
}

// The dialog lists these sections; settingsHeight() sizes the dialog from the
// same list so every row shows without scrolling.
const SECTIONS = [
  { title: "General", rows: [
    ui => ui.choices("Status icon position", STATUS_POSITION_KEY, [["start", "Left"], ["end", "Right"]], "end"),
    ui => ui.toggle("Git branch and remote", SHOW_GIT_BRANCH),
    ui => ui.toggle("Git changes and conflicts", SHOW_GIT_CHANGES),
    ui => ui.toggle("Git ahead and behind counts", SHOW_GIT_SYNC),
  ] },
  { title: "Spaces", rows: [
    ui => ui.toggle("Machine CPU and memory", SHOW_USAGE),
    ui => ui.toggle("Listening ports", SHOW_PORTS),
    ui => ui.toggle("Expand child terminals by default", EXPAND_TERMINALS),
    ui => ui.toggle("Show keep-awake button", SHOW_CUP).tooltip("The button stays visible while this Mac is being kept awake."),
  ] },
  { title: "Agents", rows: [
    ui => ui.choices("Sort agents", AGENT_SORT, [["priority", "Priority"], ["grouped", "Grouped by space"]]),
    ui => ui.toggle("Expand child agents by default", EXPAND_CHILDREN),
    ui => ui.choices("Clear unread when", UNREAD_CLEAR, [["view", "Viewed"], ["manual", "Marked read"]])
      .id("setting-unread-clear").tooltip("Viewed: leaving a marked agent and coming back reads it. Marked read: only Mark as read does. A new turn always clears it."),
    ui => ui.choices("Unread color", UNREAD_COLOR, UNREAD_COLORS),
  ] },
];

const HEADER_H = 53, FOOTER_H = 48, BODY_PAD = 12, SECTION_GAP = 12;
const TITLE_H = 16, TITLE_GAP = 5, BOX_PAD = 3, BOX_BORDER = 1, ROW_H = 34;
// The overlay's own frame draws a border around the mod.
const FRAME = 2;

export const settingsHeight = () => HEADER_H + FOOTER_H + 2 * BODY_PAD + FRAME +
  SECTIONS.reduce((h, s) => h + TITLE_H + TITLE_GAP + 2 * (BOX_PAD + BOX_BORDER) + s.rows.length * ROW_H, 0) +
  SECTION_GAP * (SECTIONS.length - 1);

export const settingsOverlay = mod => ({ mod, kind: "dialog", width: 510, height: settingsHeight(), props: { sidebarSettings: true } });

export function settingsDialog(t, overlay, cursorStyle = "cursor_pointer") {
  const row = label => h_flex().h(ROW_H).px(11).gap(12).flex_none().items_center()
    .child(div().flex_1().min_w(0).truncate().child(label));
  const section = (title, rows) => v_flex().gap(TITLE_GAP).flex_none()
    .child(div().h(TITLE_H).px(2).flex().items_center().text_size(12).font_semibold().text_color(t.muted).child(title))
    .child(v_flex().py(BOX_PAD).rounded(8).border_1().border_color(t.border).bg(t.surface).children(rows));
  const toggle = (label, key) => {
    const on = enabled(key);
    return row(label).id(`setting-${key}`).rounded(6)[cursorStyle]()
      .hover(s => s.bg(t.hover)).on_click(() => setShared(key, !enabled(key)))
      .child(div().w(32).h(18).p(2).flex_none().flex().items_center().rounded_full()
        .bg(on ? t.accent : t.input)
        .when(on, el => el.justify_end()).when(!on, el => el.justify_start())
        .child(div().size(14).flex_none().rounded_full().bg(on ? t.accent_foreground : t.muted)));
  };
  const choices = (label, key, options, fallback = options[0][0]) => {
    const selected = options.find(([id]) => id === shared(key))?.[0] ?? fallback;
    return row(label).child(h_flex().p(2).gap(2).rounded(6).bg(t.input).flex_none()
      .children(options.map(([id, text, color]) => div().id(`setting-${key}-${id}`).px(8).h(24).rounded(4)
        .flex().items_center().gap(5)[cursorStyle]()
        .when(Boolean(color), el => el.child(div().size(8).flex_none().rounded(4).bg(t[color]))).text_size(12).text_color(id === selected ? t.foreground : t.muted)
        .when(id === selected, el => el.bg(t.raised).font_semibold())
        .when(id !== selected, el => el.hover(s => s.bg(t.hover).text_color(t.foreground)))
        .on_click(() => setShared(key, id)).child(text))));
  };
  const ui = { toggle, choices };
  // Sized to fit (settingsHeight); the scrollbar is only for a window too short for that.
  return v_flex().size_full().min_h(0).bg(t.popover).text_size(13).text_color(t.foreground)
    .child(h_flex().h(HEADER_H).flex_none().px(18).items_center().border_b(1).border_color(t.border)
      .child(div().text_size(17).font_semibold().child("Ultimate Sidebar Settings")))
    .child(v_flex().id("sidebar-settings-scroll").flex_1().min_h(0).px(18).py(BODY_PAD).gap(SECTION_GAP)
      .overflow_y_scrollbar().mode("hover")
      .children(SECTIONS.map(s => section(s.title, s.rows.map(make => make(ui))))))
    .child(h_flex().h(FOOTER_H).flex_none().px(18).items_center().justify_end().border_t(1).border_color(t.border)
      .child(div().id("settings-done").px(12).h(28).flex().items_center().rounded(6)[cursorStyle]()
        .bg(t.accent).text_color(t.accent_foreground).font_semibold().hover(s => s.opacity(0.9))
        .on_click(() => closeOverlay(overlay)).child("Done")));
}
