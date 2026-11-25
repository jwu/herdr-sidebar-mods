// Keep this file identical in both mod folders so each can open the dialog.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, setShared, shared } from "herdr";
import {
  STATUS_POSITION_KEY, SHOW_USAGE, SHOW_PORTS, SHOW_CUP, EXPAND_TERMINALS,
  SHOW_GIT_BRANCH, SHOW_GIT_CHANGES, SHOW_GIT_SYNC, EXPAND_CHILDREN, AGENT_SORT, enabled,
} from "./shared.js";

export function settingsButton(t, openSettings, cursorStyle = "cursor_pointer") {
  return div().id("sidebar-settings").size(26).flex_none().flex().items_center().justify_center()
    .rounded(6)[cursorStyle]().hover(s => s.bg(t.hover)).tooltip("Sidebar settings")
    .on_click(openSettings)
    .child(svg("mods/workspace-chrome/settings.svg").size(14));
}

export function settingsDialog(t, overlay, cursorStyle = "cursor_pointer") {
  const row = label => h_flex().h(34).px(11).gap(12).flex_none().items_center()
    .child(div().flex_1().min_w(0).truncate().child(label));
  const section = (title, rows) => v_flex().gap(5).flex_none()
    .child(div().px(2).text_size(12).font_semibold().text_color(t.muted).child(title))
    .child(v_flex().py(3).rounded(8).border_1().border_color(t.border).bg(t.surface).children(rows));
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
      .children(options.map(([id, text]) => div().id(`setting-${key}-${id}`).px(8).h(24).rounded(4)
        .flex().items_center()[cursorStyle]().text_size(12).text_color(id === selected ? t.foreground : t.muted)
        .when(id === selected, el => el.bg(t.raised).font_semibold())
        .when(id !== selected, el => el.hover(s => s.bg(t.hover).text_color(t.foreground)))
        .on_click(() => setShared(key, id)).child(text))));
  };
  return v_flex().size_full().min_h(0).bg(t.popover).text_size(13).text_color(t.foreground)
    .child(h_flex().h(53).flex_none().px(18).items_center().border_b(1).border_color(t.border)
      .child(div().text_size(17).font_semibold().child("Sidebar Settings")))
    .child(v_flex().id("sidebar-settings-scroll").flex_1().min_h(0).px(18).py(12).gap(12)
      .overflow_y_scrollbar().mode("hover")
      .child(section("General", [
        choices("Status icon position", STATUS_POSITION_KEY, [["start", "Left"], ["end", "Right"]], "end"),
        toggle("Git branch and remote", SHOW_GIT_BRANCH),
        toggle("Git changes and conflicts", SHOW_GIT_CHANGES),
        toggle("Git ahead and behind counts", SHOW_GIT_SYNC),
      ]))
      .child(section("Spaces", [
        toggle("Machine CPU and memory", SHOW_USAGE),
        toggle("Listening ports", SHOW_PORTS),
        toggle("Expand child terminals by default", EXPAND_TERMINALS),
        toggle("Show keep-awake button", SHOW_CUP).tooltip("The button stays visible while this Mac is being kept awake."),
      ]))
      .child(section("Agents", [
        choices("Sort agents", AGENT_SORT, [["priority", "Priority"], ["grouped", "Grouped by space"]]),
        toggle("Expand child agents by default", EXPAND_CHILDREN),
      ])))
    .child(h_flex().h(48).flex_none().px(18).items_center().justify_end().border_t(1).border_color(t.border)
      .child(div().id("settings-done").px(12).h(28).flex().items_center().rounded(6)[cursorStyle]()
        .bg(t.accent).text_color(t.accent_foreground).font_semibold().hover(s => s.opacity(0.9))
        .on_click(() => closeOverlay(overlay)).child("Done")));
}
