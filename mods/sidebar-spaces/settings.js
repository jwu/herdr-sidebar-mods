// Keep this file identical in both mod folders so each can open the dialog.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, notify, setShared, shared } from "herdr";
import {
  STATUS_POSITION_KEY, MACHINE_STATUS_DOT, SHOW_USAGE, SHOW_PORTS, SHOW_CUP, EXPAND_TERMINALS,
  SHOW_GIT_BRANCH, SHOW_GIT_CHANGES, SHOW_GIT_SYNC, SHOW_PARENT_TERMINAL_IDS, SHOW_CHILD_TERMINAL_IDS,
  EXPAND_CHILDREN, AGENT_SORT, UNREAD_CLEAR, UNREAD_COLOR, UNREAD_COLORS, enabled,
} from "./shared.js";
import { AGENT_PROMPT, CHECK_UPDATES, checkForUpdate, markUpdateSeen, updateState } from "./update.js";

// A dot on the gear marks a release the person has not seen in the dialog yet.
export function settingsButton(t, openSettings, cursorStyle = "cursor_pointer") {
  const update = updateState();
  return div().id("sidebar-settings").relative().size(26).flex_none().flex().items_center().justify_center()
    .rounded(6)[cursorStyle]().hover(s => s.bg(t.hover))
    .tooltip(update.unseen ? `Sidebar settings: ${update.latest} is available` : "Sidebar settings")
    .on_click((event, cx) => { markUpdateSeen(); openSettings(event, cx); })
    .child(svg("mods/workspace-chrome/settings.svg").size(14))
    .when(update.unseen, el => el.child(div().id("sidebar-update-dot").absolute().top(4).right(4)
      .size(6).rounded_full().bg(t.ansi1)));
}

// The Updates section's second row: the installed version, or the newer one
// with its release page and the line to give an agent. Nothing is installed here.
function updateRow(ui) {
  const u = updateState();
  const label = u.available ? `${u.latest} is available (you have ${u.current})`
    : u.checking ? `Version ${u.current} · checking…`
    : u.error ? `Version ${u.current} · check failed (${u.error})`
    : u.checkedAt && u.latest ? `Version ${u.current} · up to date` : `Version ${u.current}`;
  const row = ui.row(label, u.available ? "accent" : !u.checking && u.error ? "ansi1" : null).id("setting-update")
    .when(!u.available && !u.checking && Boolean(u.error), el => el.tooltip(`The last check failed: ${u.error}. It tries again within the hour.`));
  if (u.available) {
    return row
      .child(ui.button("update-release", "Release", (_e, cx) => cx.open_url(u.url)))
      .child(ui.button("update-copy", "Copy for agent", (_e, cx) => {
        cx.write_to_clipboard(AGENT_PROMPT);
        notify({ title: "Update line copied", body: "Paste it to an agent to update the sidebar mods.", level: "success", timeout: 4000 });
      }, true).tooltip(AGENT_PROMPT));
  }
  return row.child(ui.button("update-check", u.checking ? "Checking…" : "Check now",
    (_e, cx) => { if (!u.checking) cx.spawn(() => checkForUpdate({ force: true })); }));
}

// The dialog lists these sections; settingsHeight() sizes the dialog from the
// same list so every row shows without scrolling.
const SECTIONS = [
  { title: "General", rows: [
    ui => ui.choices("Status icon position", STATUS_POSITION_KEY, [["start", "Left"], ["end", "Right"]], "end"),
    ui => ui.toggle("Git branch and remote", SHOW_GIT_BRANCH),
    ui => ui.toggle("Git changes and conflicts", SHOW_GIT_CHANGES),
    ui => ui.toggle("Git ahead and behind counts", SHOW_GIT_SYNC),
    ui => ui.toggle("Show parent terminal IDs", SHOW_PARENT_TERMINAL_IDS)
      .tooltip("Show the ID next to the machine name on top-level rows in Agents."),
    ui => ui.toggle("Show child terminal IDs", SHOW_CHILD_TERMINAL_IDS)
      .tooltip("Show IDs next to terminal names in Spaces and on child rows in Agents."),
  ] },
  { title: "Spaces", rows: [
    ui => ui.choices("Machine status dot", MACHINE_STATUS_DOT,
      [["off", "Off"], ["start", "First"], ["after-icon", "After Icon"], ["end", "Last"]]),
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
  { title: "Updates", rows: [
    ui => ui.toggle("Check for updates daily", CHECK_UPDATES)
      .tooltip("Asks GitHub for the latest release once a day. Nothing is downloaded or changed."),
    updateRow,
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
  const row = (label, color) => h_flex().h(ROW_H).px(11).gap(12).flex_none().items_center()
    .child(div().flex_1().min_w(0).truncate().when(Boolean(color), el => el.text_color(t[color])).child(label));
  const button = (id, text, onClick, primary = false) => div().id(id).px(10).h(24).flex_none().flex().items_center()
    .rounded(5).text_size(12)[cursorStyle]()
    .when(primary, el => el.bg(t.accent).text_color(t.accent_foreground).font_semibold().hover(s => s.opacity(0.9)))
    .when(!primary, el => el.bg(t.input).hover(s => s.bg(t.hover)))
    .on_click(onClick).child(text);
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
  const ui = { row, button, toggle, choices };
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
