Ask the user to fill in one HTML form; blocks until they submit or cancel.

<conditions>
- Missing information or a choice materially affects correctness, scope, compatibility, or risk and cannot be resolved from available context.
</conditions>

<instruction>
- `html`: one <form> of plain semantic HTML, rendered natively in the user's terminal.
  - NEVER <script>, <style>, style=, or buttons (<button>, type="submit"): the UI supplies Submit and Cancel.
- Every control needs a name; the submitted form data arrives as JSON `{"name": value}`.
- One-of: `<input type="radio">`; many-of: type="checkbox"; long lists: <select>.
- Wrap each control in a <label>; group a question in a <fieldset> with a <legend>, or put it in a <p> right before the group.
- Radio and checkbox groups automatically get an "Other" free-text answer. NEVER add your own "Other" option or a text field for it.
- Preselect your recommendation with checked/selected/value: those values are submitted if the user does not answer in time.
- Context the user needs to decide (findings, tradeoffs, diffs, drafts) goes inside the form: <p>, <ul>, <table>, <pre>.
- Keep forms short: a few questions, 2–5 options each; ask follow-ups in a later call.
- Answer values:
  - radio group or <select> → the chosen value
  - checkbox group (shared name) or <select multiple> → an array
  - lone checkbox or radio group left unchecked → omitted
  - type="number" → a number; text fields → their text
  - automatic "Other" text → the radio's value, or an extra checkbox array entry
- Free input: `<input type="text|number|date|email|url">`, <textarea>; placeholder, min/max, pattern, required are enforced.
- Pictures: `<img src="…" alt="…">` and inline <svg> diagrams, as their own blocks.
  - `src`: an http(s) URL, a data: URI, or a file path relative to the working directory.
  - Inside a <label> an image shows only its alt.
- Example, a choice with context and a number:
```html
<form>
  <p>Sessions live in memory and are lost on restart.</p>
  <fieldset>
    <legend>Session store</legend>
    <label><input type="radio" name="store" value="sqlite" checked> SQLite: one file, no new service</label>
    <label><input type="radio" name="store" value="redis"> Redis: shared across instances, needs ops</label>
  </fieldset>
  <label>Session lifetime (days) <input type="number" name="ttl_days" value="30" min="1"></label>
</form>
```
</instruction>

<caution>
- Provide 2-5 concise, distinct options.
</caution>

<critical>
- Investigate factual questions through the relevant available sources. Use project conventions and reasonable defaults for routine choices; ask when the remaining uncertainty needs the user's decision.
- Explain what the answer enables and recommend an option when useful. Continue independent, authorized work while waiting; keep dependent work paused when the answer is required.
- Use the designated approval mechanism for permission requests. Technical facts and unanswered questions do not supply authorization.
- Do NOT include "Other"; UI automatically adds "Other (type your own)" to every question.
</critical>
