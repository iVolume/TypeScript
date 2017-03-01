/* @internal */
namespace ts.textChanges {

    function getPos(n: TextRange) {
        return (<any>n)["__pos"];
    }

    function setPos(n: TextRange, pos: number) {
        (<any>n)["__pos"] = pos;
    }

    function getEnd(n: TextRange) {
        return (<any>n)["__end"];
    }

    function setEnd(n: TextRange, end: number) {
        (<any>n)["__end"] = end;
    }

    export interface ConfigurableStart {
        useNonAdjustedStartPosition?: boolean
    }
    export interface ConfigurableEnd {
        useNonAdjustedEndPosition?: boolean
    }

    /**
     * Usually node.pos points to a position immediately after the previous token.
     * If this position is used as a beginning of the span to remove - it might lead to removing the trailing trivia of the previous node, i.e:
     * const x; // this is x
     *        ^ - pos for the next variable declaration will point here
     * const y; // this is y
     *        ^ - end for previous variable declaration
     * Usually leading trivia of the variable declaration 'y' should not include trailing trivia (whitespace, comment 'this is x' and newline) from the preceding 
     * variable declaration and trailing trivia for 'y' should include (whitespace, comment 'this is y', newline).
     * By default when removing nodes we adjust start and end positions to respect specification of the trivia above.
     * If pos\end should be interpreted literally 'useNonAdjustedStartPosition' or 'useNonAdjustedEndPosition' should be set to true
     */
    export type ConfigurableStartEnd = ConfigurableStart & ConfigurableEnd;

    export interface InsertNodeOptions {
        /**
         * Set this value to true to make sure that node text of newly inserted node ends with new line
         */
        insertTrailingNewLine?: boolean;
        /**
         * Set this value to true to make sure that node text of newly inserted node starts with new line
         */
        insertLeadingNewLine?: boolean;
        /**
         * Text of inserted node will be formatted with this indentation, otherwise indentation will be inferred from the old node
         */
        indentation?: number;
        /**
         * Text of inserted node will be formatted with this delta, otherwise delta will be inferred from the new node kind
         */
        delta?: number;
    }

    export type ChangeNodeOptions = ConfigurableStartEnd & InsertNodeOptions;

    interface Change {
        readonly sourceFile: SourceFile;
        readonly range: TextRange;
        readonly oldNode?: Node;
        readonly node?: Node;
        readonly options?: ChangeNodeOptions;
    }

    function getAdjustedStartPosition(sourceFile: SourceFile, node: Node, options: ConfigurableStart) {
        if (options.useNonAdjustedStartPosition) {
            return node.getFullStart();
        }
        const fullStart = node.getFullStart();
        const start = node.getStart(sourceFile);
        if (fullStart === start) {
            return start;
        }
        const fullStartLine = getLineStartPositionForPosition(fullStart, sourceFile);
        const startLine = getLineStartPositionForPosition(start, sourceFile);
        if (startLine === fullStartLine) {
            return start;
        }
        // get start position of the line following the line that contains fullstart position
        let adjustedStartPosition = getStartPositionOfLine(getLineOfLocalPosition(sourceFile, fullStartLine) + 1, sourceFile);
        // skip whitespaces/newlines
        adjustedStartPosition = skipTrivia(sourceFile.text, adjustedStartPosition, /*stopAfterLineBreak*/ false, /*stopAtComments*/ true);
        return getStartPositionOfLine(getLineOfLocalPosition(sourceFile, adjustedStartPosition), sourceFile);
    }

    function getAdjustedEndPosition(sourceFile: SourceFile, node: Node, options: ConfigurableEnd) {
        if (options.useNonAdjustedEndPosition) {
            return node.getEnd();
        }
        const end = node.getEnd();
        const newEnd = skipTrivia(sourceFile.text, end, /*stopAfterLineBreak*/ true);
        // check if last character before newPos is linebreak
        // if yes - considered all skipped trivia to be trailing trivia of the node
        return newEnd !== end && isLineBreak(sourceFile.text.charCodeAt(newEnd - 1))
            ? newEnd
            : end;
    }

    export class ChangeTracker {
        private changes: Change[] = [];

        constructor(
            private readonly newLine: NewLineKind,
            private readonly rulesProvider: formatting.RulesProvider,
            private readonly validator?: (text: NonFormattedText) => void) {
        }

        /**
         * Records a change to remove a node from the file
         * @param sourceFile - target source file (should be the same as node.getSourceFile)
         * @param node - node to remove
         * @param options - options to tweak deletion 
         */
        public deleteNode(sourceFile: SourceFile, node: Node, options: ConfigurableStartEnd = {}): void {
            const startPosition = getAdjustedStartPosition(sourceFile, node, options);
            const endPosition = getAdjustedEndPosition(sourceFile, node, options);
            this.changes.push({ sourceFile, options, range: { pos: startPosition, end: endPosition } });
        }

        /**
         * Records a change to remove a text range from the file
         * @param _sourceFile - target source file
         * @param range - range to remove
         */
        public deleteRange(sourceFile: SourceFile, range: TextRange): void {
            this.changes.push({ sourceFile, range });
        }

        public deleteNodeRange(sourceFile: SourceFile, startNode: Node, endNode: Node, options: ConfigurableStartEnd = {}): void {
            const startPosition = getAdjustedStartPosition(sourceFile, startNode, options);
            const endPosition = getAdjustedEndPosition(sourceFile, endNode, options);
            this.changes.push({ sourceFile, options, range: { pos: startPosition, end: endPosition } });
        }

        public replaceRange(sourceFile: SourceFile, range: TextRange, newNode: Node, options: InsertNodeOptions = {}): void {
            this.changes.push({ sourceFile, range, options, node: newNode });
        }

        public replaceNode(sourceFile: SourceFile, oldNode: Node, newNode: Node, options: ChangeNodeOptions = {}): void {
            const startPosition = getAdjustedStartPosition(sourceFile, oldNode, options);
            const endPosition = getAdjustedEndPosition(sourceFile, oldNode, options);
            this.changes.push({ sourceFile, options, oldNode, node: newNode, range: { pos: startPosition, end: endPosition } });
        }

        public replaceNodeRange(sourceFile: SourceFile, startNode: Node, endNode: Node, newNode: Node, options: ChangeNodeOptions = {}): void {
            const startPosition = getAdjustedStartPosition(sourceFile, startNode, options);
            const endPosition = getAdjustedEndPosition(sourceFile, endNode, options);
            this.changes.push({ sourceFile, options, oldNode: startNode, node: newNode, range: { pos: startPosition, end: endPosition } });
        }

        public insertNodeAt(sourceFile: SourceFile, pos: number, newNode: Node, options: InsertNodeOptions = {}): void {
            this.changes.push({ sourceFile, options, node: newNode, range: { pos: pos, end: pos } });
        }

        public insertNodeBefore(sourceFile: SourceFile, before: Node, newNode: Node, options: InsertNodeOptions & ConfigurableStart = {}) {
            const startPosition = getAdjustedStartPosition(sourceFile, before, options);
            this.changes.push({ sourceFile, options, oldNode: before, node: newNode, range: { pos: startPosition, end: startPosition } });
        }

        public insertNodeAfter(sourceFile: SourceFile, after: Node, newNode: Node, options: InsertNodeOptions & ConfigurableEnd = {}) {
            const endPosition = getAdjustedEndPosition(sourceFile, after, options);
            this.changes.push({ sourceFile, options, oldNode: after, node: newNode, range: { pos: endPosition, end: endPosition } });
        }

        public getChanges(): FileTextChanges[] {
            const changesPerFile = createFileMap<Change[]>();
            // group changes per file
            for (const c of this.changes) {
                let changesInFile = changesPerFile.get(c.sourceFile.path);
                if (!changesInFile) {
                    changesPerFile.set(c.sourceFile.path, changesInFile = []);
                }[]
                changesInFile.push(c);
            }
            // convert changes
            const fileChangesList: FileTextChanges[] = [];
            changesPerFile.forEachValue(path => {
                const changesInFile = changesPerFile.get(path);
                const sourceFile = changesInFile[0].sourceFile;
                ChangeTracker.normalize(changesInFile);

                const fileTextChanges: FileTextChanges = { fileName: sourceFile.fileName, textChanges: [] };
                for (const c of changesInFile) {
                    fileTextChanges.textChanges.push({
                        span: this.computeSpan(c, sourceFile),
                        newText: this.computeNewText(c, sourceFile)
                    });
                }
                fileChangesList.push(fileTextChanges);
            })

            return fileChangesList;
        }

        private computeSpan(change: Change, _sourceFile: SourceFile): TextSpan {
            return createTextSpanFromBounds(change.range.pos, change.range.end);
        }

        private computeNewText(change: Change, sourceFile: SourceFile): string {
            if (!change.node) {
                // deletion case
                return "";
            }
            const options = change.options || {};
            const nonFormattedText = getNonformattedText(change.node, sourceFile, this.newLine);
            if (this.validator) {
                this.validator(nonFormattedText);
            }
            const formatOptions = this.rulesProvider.getFormatOptions();
            const initialIndentation =
                change.options.indentation !== undefined
                    ? change.options.indentation
                    : change.oldNode
                        ? formatting.SmartIndenter.getIndentationForNode(change.oldNode, undefined, sourceFile, formatOptions)
                        : 0;
            const delta =
                change.options.delta !== undefined
                    ? change.options.delta
                    : formatting.SmartIndenter.shouldIndentChildNode(change.node)
                        ? formatOptions.indentSize
                        : 0;
            const pos = change.range.pos;
            const lineStart = getLineStartPositionForPosition(pos, sourceFile);

            let text = applyFormatting(nonFormattedText, sourceFile, initialIndentation, delta, this.rulesProvider);
            // strip initial indentation (spaces or tabs) if text will be inserted in the middle of the line
            text = pos !== lineStart ? text.replace(/^\s+/, "") : text;
            const newLineString = getNewLineCharacter(this.newLine);
            if (options.insertLeadingNewLine) {
                text = newLineString + text;
            }
            if (options.insertTrailingNewLine) {
                text = text + newLineString;
            }
            return text;
        }

        private static normalize(changes: Change[]) {
            // order changes by start position
            changes.sort((a, b) => a.range.pos - b.range.pos);
            // verify that end position of the change is less than start position of the next change
            for (let i = 0; i < changes.length - 2; i++) {
                Debug.assert(changes[i].range.end <= changes[i + 1].range.pos);
            }
        }
    }

    export interface NonFormattedText {
        readonly text: string;
        readonly node: Node;
    }

    export function getNonformattedText(node: Node, sourceFile: SourceFile, newLine: NewLineKind): NonFormattedText {
        const writer = new Writer(getNewLineCharacter(newLine));
        const printer = createPrinter({ newLine, target: sourceFile.languageVersion }, writer);
        printer.writeNode(EmitHint.Unspecified, node, sourceFile, writer);
        return { text: writer.getText(), node: assignPositionsToNode(node) };
    }

    export function applyFormatting(nonFormattedText: NonFormattedText, sourceFile: SourceFile, initialIndentation: number, delta: number, rulesProvider: formatting.RulesProvider) {
        const lineMap = computeLineStarts(nonFormattedText.text);
        const file: SourceFileLike = {
            text: nonFormattedText.text,
            lineMap,
            getLineAndCharacterOfPosition: pos => computeLineAndCharacterOfPosition(lineMap, pos)
        }
        const changes = formatting.formatNode(nonFormattedText.node, file, sourceFile.languageVariant, initialIndentation, delta, rulesProvider);
        return applyChanges(nonFormattedText.text, changes);
    }

    export function applyChanges(text: string, changes: TextChange[]): string {
        for (let i = changes.length - 1; i >= 0; i--) {
            const change = changes[i];
            text = `${text.substring(0, change.span.start)}${change.newText}${text.substring(textSpanEnd(change.span))}`
        }
        return text;
    }

    function isTrivia(s: string) {
        return skipTrivia(s, 0) === s.length;
    }

    const nullTransformationContext: TransformationContext = {
        enableEmitNotification: noop,
        enableSubstitution: noop,
        endLexicalEnvironment: () => undefined,
        getCompilerOptions: notImplemented,
        getEmitHost: notImplemented,
        getEmitResolver: notImplemented,
        hoistFunctionDeclaration: noop,
        hoistVariableDeclaration: noop,
        isEmitNotificationEnabled: notImplemented,
        isSubstitutionEnabled: notImplemented,
        onEmitNode: noop,
        onSubstituteNode: notImplemented,
        readEmitHelpers: notImplemented,
        requestEmitHelper: noop,
        resumeLexicalEnvironment: noop,
        startLexicalEnvironment: noop,
        suspendLexicalEnvironment: noop
    }

    function assignPositionsToNode(node: Node): Node {
        const visited = visitEachChild(node, assignPositionsToNode, nullTransformationContext, assignPositionsToNodeArray);
        // create proxy node for non synthesized nodes
        const newNode = nodeIsSynthesized(visited)
            ? visited
            : (Proxy.prototype = visited, new (<any>Proxy)());
        newNode.pos = getPos(node);
        newNode.end = getEnd(node);
        return newNode;

        function Proxy() { }
    }

    function assignPositionsToNodeArray(nodes: NodeArray<any>, visitor: Visitor, test?: (node: Node) => boolean, start?: number, count?: number) {
        const visited = visitNodes(nodes, visitor, test, start, count);
        if (!visited) {
            return visited;
        }
        // clone nodearray if necessary
        const nodeArray = visited === nodes ? createNodeArray(visited) : visited;
        nodeArray.pos = getPos(nodes);
        nodeArray.end = getEnd(nodes);
        return nodeArray;
    }

    class Writer implements EmitTextWriter, PrintHandlers {
        private lastNonTriviaPosition = 0;
        private readonly writer: EmitTextWriter;

        public readonly onEmitNode: PrintHandlers["onEmitNode"];
        public readonly onBeforeEmitNodeArray: PrintHandlers["onBeforeEmitNodeArray"];
        public readonly onAfterEmitNodeArray: PrintHandlers["onAfterEmitNodeArray"];

        constructor(newLine: string) {
            this.writer = createTextWriter(newLine)
            this.onEmitNode = (hint, node, printCallback) => {
                setPos(node, this.lastNonTriviaPosition);
                printCallback(hint, node);
                setEnd(node, this.lastNonTriviaPosition);
            };
            this.onBeforeEmitNodeArray = nodes => {
                if (nodes) {
                    setPos(nodes, this.lastNonTriviaPosition)
                }
            };
            this.onAfterEmitNodeArray = nodes => {
                if (nodes) {
                    setEnd(nodes, this.lastNonTriviaPosition);
                }
            };
        }

        private setLastNonTriviaPosition(s: string, force: boolean) {
            if (force || !isTrivia(s)) {
                this.lastNonTriviaPosition = this.writer.getTextPos();
                let i = 0;
                while (isWhiteSpace(s.charCodeAt(s.length - i - 1))) {
                    i++;
                }
                // trim trailing whitespaces
                this.lastNonTriviaPosition -= i;
            }
        }

        write(s: string): void {
            this.writer.write(s);
            this.setLastNonTriviaPosition(s, /*force*/ false);
        }
        writeTextOfNode(text: string, node: Node): void {
            this.writer.writeTextOfNode(text, node);
        }
        writeLine(): void {
            this.writer.writeLine();
        }
        increaseIndent(): void {
            this.writer.increaseIndent();
        }
        decreaseIndent(): void {
            this.writer.decreaseIndent();
        }
        getText(): string {
            return this.writer.getText();
        }
        rawWrite(s: string): void {
            this.writer.rawWrite(s);
            this.setLastNonTriviaPosition(s, /*force*/ false);
        }
        writeLiteral(s: string): void {
            this.writer.writeLiteral(s);
            this.setLastNonTriviaPosition(s, /*force*/ true);
        }
        getTextPos(): number {
            return this.writer.getTextPos();
        }
        getLine(): number {
            return this.writer.getLine();
        }
        getColumn(): number {
            return this.writer.getColumn();
        }
        getIndent(): number {
            return this.writer.getIndent();
        }
        isAtStartOfLine(): boolean {
            return this.writer.isAtStartOfLine();
        }
        reset(): void {
            this.writer.reset();
            this.lastNonTriviaPosition = 0;
        }
    }
}