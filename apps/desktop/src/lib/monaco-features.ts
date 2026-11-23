// The parts of the Monaco editor Forge-Code uses. `import "monaco-editor"` pulls in everything, including editor features
// that only work with language providers this app never registers (go to definition, rename, code actions, signature help,
// colour picker, formatting, semantic tokens, diff editor, ...) and the TypeScript/HTML/CSS language services, whose workers
// are not provided here and so could never run. Leaving them out makes the engine smaller to download, parse and hold.
//
// Kept on purpose: everything for editing and navigating text, find, folding, multi-cursor, hover (it shows diagnostics from
// the language servers), go to next problem, suggestions and inline (ghost-text) completions, the accessibility commands
// (tab-focus toggle, high contrast), unicode-highlight warnings (a security feature), the command palette (F1, where the
// "Edit selection with AI" action also lives), go to line, and the JSON language (syntax colouring comes with it).
//
// If a feature is added that needs one of the omitted modules, import it here.

export * from "monaco-editor/esm/vs/editor/editor.api";

// core
import "monaco-editor/esm/vs/editor/browser/coreCommands.js";
import "monaco-editor/esm/vs/editor/browser/widget/codeEditor/codeEditorWidget.js";
import "monaco-editor/esm/vs/editor/common/standaloneStrings.js";
import "monaco-editor/esm/vs/base/browser/ui/codicons/codiconStyles.js";

// editing and navigation
import "monaco-editor/esm/vs/editor/contrib/anchorSelect/browser/anchorSelect.js";
import "monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/esm/vs/editor/contrib/caretOperations/browser/caretOperations.js";
import "monaco-editor/esm/vs/editor/contrib/caretOperations/browser/transpose.js";
import "monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/esm/vs/editor/contrib/comment/browser/comment.js";
import "monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/esm/vs/editor/contrib/cursorUndo/browser/cursorUndo.js";
import "monaco-editor/esm/vs/editor/contrib/dnd/browser/dnd.js";
import "monaco-editor/esm/vs/editor/contrib/find/browser/findController.js";
import "monaco-editor/esm/vs/editor/contrib/folding/browser/folding.js";
import "monaco-editor/esm/vs/editor/contrib/fontZoom/browser/fontZoom.js";
import "monaco-editor/esm/vs/editor/contrib/indentation/browser/indentation.js";
import "monaco-editor/esm/vs/editor/contrib/lineSelection/browser/lineSelection.js";
import "monaco-editor/esm/vs/editor/contrib/linesOperations/browser/linesOperations.js";
import "monaco-editor/esm/vs/editor/contrib/links/browser/links.js";
import "monaco-editor/esm/vs/editor/contrib/longLinesHelper/browser/longLinesHelper.js";
import "monaco-editor/esm/vs/editor/contrib/multicursor/browser/multicursor.js";
import "monaco-editor/esm/vs/editor/contrib/smartSelect/browser/smartSelect.js";
import "monaco-editor/esm/vs/editor/contrib/stickyScroll/browser/stickyScrollContribution.js";
import "monaco-editor/esm/vs/editor/contrib/tokenization/browser/tokenization.js";
import "monaco-editor/esm/vs/editor/contrib/wordHighlighter/browser/wordHighlighter.js";
import "monaco-editor/esm/vs/editor/contrib/wordOperations/browser/wordOperations.js";
import "monaco-editor/esm/vs/editor/contrib/wordPartOperations/browser/wordPartOperations.js";

// problems from the language servers: hover shows them, F8 steps through them
import "monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution.js";
import "monaco-editor/esm/vs/editor/contrib/gotoError/browser/gotoError.js";

// suggestions, snippets and inline (ghost-text) completions
import "monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestInlineCompletions.js";
import "monaco-editor/esm/vs/editor/contrib/snippet/browser/snippetController2.js";
import "monaco-editor/esm/vs/editor/contrib/inlineCompletions/browser/inlineCompletions.contribution.js";
import "monaco-editor/esm/vs/editor/contrib/placeholderText/browser/placeholderText.contribution.js";

// accessibility and safety
import "monaco-editor/esm/vs/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js";
import "monaco-editor/esm/vs/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter.js";
import "monaco-editor/esm/vs/editor/contrib/unusualLineTerminators/browser/unusualLineTerminators.js";
import "monaco-editor/esm/vs/editor/contrib/readOnlyMessage/browser/contribution.js";
import "monaco-editor/esm/vs/editor/standalone/browser/toggleHighContrast/toggleHighContrast.js";

// the editor's own command palette (F1) and go to line (Ctrl+G)
import "monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js";
import "monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js";

// syntax colouring: tokenizers load on demand per language; JSON brings its own
import "monaco-editor/esm/vs/basic-languages/monaco.contribution.js";
import "monaco-editor/esm/vs/language/json/monaco.contribution.js";
