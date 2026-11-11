import { createPrompt, isDownKey, isEnterKey, isTabKey, isUpKey, makeTheme, usePagination, usePrefix, useKeypress, useMemo, useState } from "@inquirer/core";
import { styleText } from "node:util";

/**
 * Choosing several from a long list by typing to filter. Space is part of the search, so
 * "dsgn sys" works; Tab picks or drops the highlighted item, and Enter finishes. Enter with
 * nothing picked takes the highlighted item, so a single choice needs no Tab. When the
 * question is optional, Enter with nothing picked answers "none" instead.
 */

type Choice<T> = { value: T; name: string; description?: string; checked?: boolean };

type Config<T> = {
  message: string;
  choices: Array<Choice<T>>;
  rank: (term: string, choices: Array<Choice<T>>) => Array<Choice<T>>;
  pageSize?: number;
  /** Picking nothing is an answer. */
  optional?: boolean;
};

export const searchMany = createPrompt(<T>(config: Config<T>, done: (value: T[]) => void) => {
  const theme = makeTheme({});
  const [status, setStatus] = useState<"idle" | "done">("idle");
  const [term, setTerm] = useState("");
  const [picked, setPicked] = useState<T[]>(config.choices.filter((c) => c.checked).map((c) => c.value));
  const [active, setActive] = useState(0);
  const prefix = usePrefix({ status, theme });
  const results = useMemo(() => config.rank(term, config.choices), [term]);
  const current = results[Math.min(active, results.length - 1)];

  useKeypress((key, rl) => {
    if (isEnterKey(key)) {
      const value = picked.length > 0 || config.optional ? picked : current ? [current.value] : [];
      if (value.length === 0 && !config.optional) return;
      setPicked(value);
      setStatus("done");
      done(value);
    } else if (isTabKey(key)) {
      rl.clearLine(0);
      rl.write(term);
      if (current) setPicked(picked.includes(current.value) ? picked.filter((v) => v !== current.value) : [...picked, current.value]);
    } else if (isUpKey(key) || isDownKey(key)) {
      rl.clearLine(0);
      rl.write(term);
      if (results.length > 0) setActive((Math.min(active, results.length - 1) + (isUpKey(key) ? -1 : 1) + results.length) % results.length);
    } else {
      setTerm(rl.line);
      setActive(0);
    }
  });

  const message = theme.style.message(config.message, status);
  if (status === "done") {
    const names = config.choices.filter((c) => picked.includes(c.value)).map((c) => c.name);
    return [prefix, message, theme.style.answer(names.join(", ") || "none")].join(" ");
  }
  const page = usePagination({
    items: results,
    active: Math.min(active, Math.max(0, results.length - 1)),
    renderItem: ({ item, isActive }) => {
      const box = picked.includes(item.value) ? styleText("green", "◉") : "◯";
      const line = `${isActive ? "❯" : " "} ${box} ${item.name}`;
      return isActive ? theme.style.highlight(line) : line;
    },
    pageSize: config.pageSize ?? 12,
    loop: false,
  });
  const header = [prefix, message, styleText("cyan", term)].filter(Boolean).join(" ");
  const count = `${results.length} of ${config.choices.length} shown, ${picked.length} picked`;
  const help = [["type", "filter"], ["↑↓", "move"], ["tab", "pick"], ["⏎", config.optional && picked.length === 0 ? "none" : "done"]].map(([k, a]) => `${styleText("bold", k!)} ${styleText("dim", a!)}`).join(styleText("dim", " • "));
  const body = [results.length > 0 ? page : theme.style.error("No matches"), " ", current?.description ? styleText("cyan", current.description) : "", styleText("dim", count), help].filter(Boolean).join("\n");
  return [header, body];
});
