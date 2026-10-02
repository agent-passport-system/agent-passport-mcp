// A deliberately small reader for GitHub workflow files.
//
// The release guards are only worth what their placement is worth, and the
// previous round of tests exercised the guard's logic without ever looking at
// the workflow that calls it. Removing the guard step from release.yml left
// every test passing. So this reader exists to answer two structural
// questions, and only those two: which jobs does a workflow declare, and in
// what order do a job's steps appear.
//
// It is not a YAML parser and must not grow into one. Everything past job and
// step boundaries is matched against the step's raw text, which is the
// stricter choice here: a protected effect cannot be hidden from it by moving
// `npm publish` from `run` into some other key.

const BLOCK_SCALAR_KEY = /^(?:-\s+)?[^#\s][^:]*:\s*[|>][-+]?[0-9]*\s*(?:#.*)?$/;
const PLAIN_KEY = /^([A-Za-z_][A-Za-z0-9_.-]*):\s*(.*)$/;

export function indentOf(line) {
  return line.length - line.trimStart().length;
}

export function isBlank(line) {
  return line.trim() === '';
}

export function isComment(line) {
  return /^\s*#/.test(line);
}

// Lines inside a `|` or `>` block belong to a scalar, not to the document's
// structure. A `run:` body can contain anything, including lines that look
// like keys or like sequence items, so those lines are masked out before any
// boundary is looked for.
export function blockScalarMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let keyIndent = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (keyIndent >= 0) {
      if (isBlank(line) || indentOf(line) > keyIndent) {
        mask[i] = true;
        continue;
      }
      keyIndent = -1;
    }

    if (isBlank(line) || isComment(line)) continue;
    if (BLOCK_SCALAR_KEY.test(line.trim())) keyIndent = indentOf(line);
  }

  return mask;
}

function structural(lines, mask) {
  return (i) => !mask[i] && !isBlank(lines[i]) && !isComment(lines[i]);
}

// The half-open line range of the block introduced at `start`: every following
// line indented deeper than `start`, stopping at the first structural line that
// is not.
function blockEnd(lines, mask, start, indent) {
  const isStructural = structural(lines, mask);
  for (let i = start + 1; i < lines.length; i += 1) {
    if (!isStructural(i)) continue;
    if (indentOf(lines[i]) <= indent) return i;
  }
  return lines.length;
}

function findTopLevelKey(lines, mask, key) {
  const isStructural = structural(lines, mask);
  const pattern = new RegExp(`^${key}:\\s*(.*)$`);
  for (let i = 0; i < lines.length; i += 1) {
    if (!isStructural(i) || indentOf(lines[i]) !== 0) continue;
    const match = pattern.exec(lines[i]);
    if (match) return { line: i, inline: match[1].trim() };
  }
  return null;
}

// The event names a workflow responds to. `on` is quoted here because YAML 1.1
// readers fold a bare `on` to true; the workflow files use the bare form, so
// the key is matched as written rather than through a loaded document.
export function triggersOf(text) {
  const lines = text.split('\n');
  const mask = blockScalarMask(lines);
  const isStructural = structural(lines, mask);

  const found = findTopLevelKey(lines, mask, 'on');
  if (!found) return [];
  if (found.inline && !found.inline.startsWith('#')) {
    const inline = found.inline.replace(/^\[|\]$/g, '');
    return inline.split(',').map((part) => part.trim()).filter(Boolean);
  }

  const end = blockEnd(lines, mask, found.line, 0);
  const triggers = [];
  let childIndent = null;
  for (let i = found.line + 1; i < end; i += 1) {
    if (!isStructural(i)) continue;
    const indent = indentOf(lines[i]);
    if (childIndent === null) childIndent = indent;
    if (indent !== childIndent) continue;
    const match = PLAIN_KEY.exec(lines[i].trim());
    if (match) triggers.push(match[1]);
  }
  return triggers;
}

export function stepsOf(lines, mask, jobStart, jobEnd, jobIndent) {
  const isStructural = structural(lines, mask);

  let stepsLine = -1;
  for (let i = jobStart + 1; i < jobEnd; i += 1) {
    if (!isStructural(i)) continue;
    if (indentOf(lines[i]) <= jobIndent) break;
    if (/^steps:\s*(?:#.*)?$/.test(lines[i].trim())) {
      stepsLine = i;
      break;
    }
  }
  if (stepsLine === -1) return [];

  const stepsIndent = indentOf(lines[stepsLine]);
  const end = Math.min(jobEnd, blockEnd(lines, mask, stepsLine, stepsIndent));

  let dashIndent = null;
  const starts = [];
  for (let i = stepsLine + 1; i < end; i += 1) {
    if (!isStructural(i)) continue;
    if (!/^-\s/.test(lines[i].trim())) continue;
    const indent = indentOf(lines[i]);
    if (dashIndent === null) dashIndent = indent;
    if (indent === dashIndent) starts.push(i);
  }

  return starts.map((start, position) => {
    const stop = position + 1 < starts.length ? starts[position + 1] : end;
    return {
      index: position,
      startLine: start + 1, // 1-indexed, to match an editor
      text: lines.slice(start, stop).join('\n'),
    };
  });
}

// The inline value of one of a job's own keys, or null. Used for
// `continue-on-error`, which at job level makes every step's failure
// non-fatal, including a gate's.
function jobField(lines, mask, jobStart, jobEnd, key) {
  const isStructural = structural(lines, mask);
  let childIndent = null;
  for (let i = jobStart + 1; i < jobEnd; i += 1) {
    if (!isStructural(i)) continue;
    const indent = indentOf(lines[i]);
    if (childIndent === null) childIndent = indent;
    if (indent !== childIndent) continue;
    const match = PLAIN_KEY.exec(lines[i].trim());
    if (match && match[1] === key) return match[2].trim();
  }
  return null;
}

export function parseWorkflow(text, { path = '<workflow>' } = {}) {
  const lines = text.split('\n');
  const mask = blockScalarMask(lines);
  const isStructural = structural(lines, mask);

  const jobsKey = findTopLevelKey(lines, mask, 'jobs');
  if (!jobsKey) return { path, triggers: triggersOf(text), jobs: [] };

  const jobsEnd = blockEnd(lines, mask, jobsKey.line, 0);

  let jobIndent = null;
  const starts = [];
  for (let i = jobsKey.line + 1; i < jobsEnd; i += 1) {
    if (!isStructural(i)) continue;
    const indent = indentOf(lines[i]);
    if (jobIndent === null) jobIndent = indent;
    if (indent !== jobIndent) continue;
    const match = PLAIN_KEY.exec(lines[i].trim());
    if (match && match[2].trim() === '') starts.push({ line: i, name: match[1] });
  }

  const jobs = starts.map((job, position) => {
    const stop = position + 1 < starts.length ? starts[position + 1].line : jobsEnd;
    return {
      name: job.name,
      startLine: job.line + 1,
      text: lines.slice(job.line, stop).join('\n'),
      continueOnError: jobField(lines, mask, job.line, stop, 'continue-on-error'),
      steps: stepsOf(lines, mask, job.line, stop, jobIndent),
    };
  });

  return { path, triggers: triggersOf(text), jobs };
}

// --- a step's own keys ------------------------------------------------------
//
// Matching a pattern against a step's raw text answers "is this filename
// mentioned here". It does not answer "does this step run that file, and does
// its failure stop the job", and the two came apart: a guard step with
// `if: false`, with `continue-on-error: true`, with its command replaced by
// `echo`, or with `|| true` appended still mentions the filename, and the
// placement rule passed all four. So a step's mapping is read one level deep.
// One level only. Nothing below a step's own keys is interpreted, and this is
// not a shell parser.

// The step's lines with the leading `- ` turned into indentation, so its first
// key sits at the same column as the rest and a `run: |` body on the first line
// does not mask the keys that follow it.
function stepLines(stepText) {
  const lines = stepText.split('\n');
  if (lines.length > 0) lines[0] = lines[0].replace(/^(\s*)-(\s)/, '$1 $2');
  return lines;
}

// The body of the block introduced at `start`: the deeper-indented lines that
// follow it, dedented, with comment lines dropped.
function blockBody(lines, mask, start, indent) {
  const isStructural = structural(lines, mask);
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (!isBlank(lines[i]) && !isComment(lines[i]) && indentOf(lines[i]) <= indent) {
      if (isStructural(i)) break;
    }
    if (isComment(lines[i])) continue;
    body.push(lines[i]);
  }
  while (body.length > 0 && isBlank(body[body.length - 1])) body.pop();
  const indents = body.filter((line) => !isBlank(line)).map(indentOf);
  const strip = indents.length > 0 ? Math.min(...indents) : 0;
  return body.map((line) => line.slice(strip)).join('\n');
}

export function stepFields(stepText) {
  const lines = stepLines(stepText);
  const mask = blockScalarMask(lines);
  const isStructural = structural(lines, mask);
  const keyIndent = lines.length > 0 ? indentOf(lines[0]) : 0;

  const fields = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    if (!isStructural(i) || indentOf(lines[i]) !== keyIndent) continue;
    const match = PLAIN_KEY.exec(lines[i].trim());
    if (!match || fields.has(match[1])) continue;
    fields.set(match[1], {
      inline: match[2].trim(),
      body: blockBody(lines, mask, i, keyIndent),
    });
  }
  return fields;
}

// What a step's `run` actually executes: the inline value, or the block scalar
// body. Null when the step has no `run` at all, which for a gate step is its
// own answer.
export function runCommandOf(stepText) {
  const run = stepFields(stepText).get('run');
  if (!run) return null;
  if (run.inline !== '' && !/^[|>]/.test(run.inline)) return run.inline;
  return run.body;
}

// The commands a `run` body contains, one per line, comments dropped. Line
// granularity is deliberate: this is enough to tell one canonical invocation
// from an `echo` of it or from a second command next to it, and a gate step is
// required to be exactly one line, so nothing finer is needed.
export function commandsIn(runBody) {
  return runBody
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

// Comments are stripped before a step is classified. A comment explaining why a
// step does NOT publish ("letting `npm publish` pack a second time would ...")
// is not a publish, and treating it as one would make the placement rule fire
// on prose.
export function effectiveText(stepText) {
  return stepText
    .split('\n')
    .filter((line) => !isComment(line))
    .join('\n');
}

export function stepMatches(stepText, pattern) {
  return pattern.test(effectiveText(stepText));
}
