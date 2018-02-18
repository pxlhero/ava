'use strict';
const path = require('path');
const figures = require('figures');
const indentString = require('indent-string');
const plur = require('plur');
const prettyMs = require('pretty-ms');
const trimOffNewlines = require('trim-off-newlines');

const chalk = require('../chalk').get();
const codeExcerpt = require('../code-excerpt');
const colors = require('./colors');
const formatSerializedError = require('./format-serialized-error');
const improperUsageMessages = require('./improper-usage-messages');
const prefixTitle = require('./prefix-title');

const whileCorked = (stream, fn) => function () {
	stream.cork();
	try {
		fn.apply(this, arguments);
	} finally {
		stream.uncork();
	}
};

class VerboseReporter {
	constructor(options) {
		this.stream = options.stream;
		this.watching = options.watching;

		this.consumeStateChange = whileCorked(this.stream, this.consumeStateChange);
		this.endRun = whileCorked(this.stream, this.endRun);

		this.reset();
	}

	reset() {
		if (this.removePreviousListener) {
			this.removePreviousListener();
		}

		this.failFastEnabled = false;
		this.failures = [];
		this.filesWithMissingAvaImports = new Set();
		this.knownFailures = [];
		this.lastLineIsEmpty = false;
		this.matching = false;
		this.prefixTitle = (testFile, title) => title;
		this.previousFailures = 0;
		this.removePreviousListener = null;
		this.stats = null;
	}

	writeLine(str) {
		str = str || '';
		this.stream.write(str + '\n');
		this.lastLineIsEmpty = str === '';
	}

	ensureEmptyLine() {
		if (!this.lastLineIsEmpty) {
			this.writeLine();
		}
	}

	startRun(plan) {
		this.reset();

		this.failFastEnabled = plan.failFastEnabled;
		this.matching = plan.matching;
		this.previousFailures = plan.previousFailures;

		if (this.watching || plan.files.length > 1) {
			this.prefixTitle = (testFile, title) => prefixTitle(plan.filePathPrefix, testFile, title);
		}

		this.removePreviousListener = plan.status.on('stateChange', evt => this.consumeStateChange(evt));

		if (this.watching && plan.runVector > 1) {
			this.writeLine(chalk.gray.dim('\u2500'.repeat(this.stream.columns || 80)));
		}

		this.writeLine();
	}

	consumeStateChange(evt) { // eslint-disable-line complexity
		const fileStats = this.stats && evt.testFile ? this.stats.byFile.get(evt.testFile) : null;

		switch (evt.type) {
			case 'declared-test':
				// Ignore
				break;
			case 'hook-failed':
				this.failures.push(evt);
				this.writeTestSummary(evt);
				break;
			case 'internal-error':
				if (evt.testFile) {
					this.writeLine(colors.error(`  ${figures.cross} Internal error when running ${path.relative('.', evt.testFile)}`));
				} else {
					this.writeLine(colors.error(`  ${figures.cross} Internal error`));
				}
				this.writeLine(indentString(colors.stack(evt.err.summary), 2));
				this.writeLine(indentString(colors.errorStack(evt.err.stack), 2));
				this.writeLine('\n\n');
				break;
			case 'missing-ava-import':
				this.filesWithMissingAvaImports.add(evt.testFile);
				this.writeLine(colors.error(`  ${figures.cross} No tests found in ${path.relative('.', evt.testFile)}, make sure to import "ava" at the top of your test file`));
				break;
			case 'selected-test':
				if (evt.skip) {
					this.writeLine('  ' + colors.skip(`- ${this.prefixTitle(evt.testFile, evt.title)}`));
				} else if (evt.todo) {
					this.writeLine('  ' + colors.todo(`- ${this.prefixTitle(evt.testFile, evt.title)}`));
				}
				break;
			case 'stats':
				this.stats = evt.stats;
				break;
			case 'test-failed':
				this.failures.push(evt);
				this.writeTestSummary(evt);
				break;
			case 'test-passed':
				if (evt.knownFailing) {
					this.knownFailures.push(evt);
				}
				this.writeTestSummary(evt);
				break;
			case 'timeout':
				this.writeLine(colors.error(`  ${figures.cross} Exited because no new tests completed within the last ${evt.period}ms of inactivity`));
				break;
			case 'uncaught-exception':
				this.ensureEmptyLine();
				this.writeLine('  ' + colors.title(`Uncaught exception in ${path.relative('.', evt.testFile)}`));
				this.writeLine();
				this.writeErr(evt);
				this.writeLine();
				break;
			case 'unhandled-rejection':
				this.ensureEmptyLine();
				this.writeLine('  ' + colors.title(`Unhandled rejection in ${path.relative('.', evt.testFile)}`));
				this.writeLine();
				this.writeErr(evt);
				this.writeLine();
				break;
			case 'worker-failed':
				if (!this.filesWithMissingAvaImports.has(evt.testFile)) {
					if (evt.nonZeroExitCode) {
						this.writeLine(colors.error(`  ${figures.cross} ${path.relative('.', evt.testFile)} exited with a non-zero exit code: ${evt.nonZeroExitCode}`));
					} else {
						this.writeLine(colors.error(`  ${figures.cross} ${path.relative('.', evt.testFile)} exited due to ${evt.signal}`));
					}
				}
				break;
			case 'worker-finished':
				if (!evt.forcedExit && !this.filesWithMissingAvaImports.has(evt.testFile)) {
					if (fileStats.declaredTests === 0) {
						this.writeLine(colors.error(`  ${figures.cross} No tests found in ${path.relative('.', evt.testFile)}`));
					} else if (!this.failFastEnabled && fileStats.remainingTests > 0) {
						this.writeLine(colors.error(`  ${figures.cross} ${fileStats.remainingTests} ${plur('test', fileStats.remainingTests)} remaining in ${path.relative('.', evt.testFile)}`));
					}
				}
				break;
			case 'worker-stderr':
			case 'worker-stdout':
				this.stream.write(evt.chunk);
				break;
			default:
				break;
		}
	}

	writeErr(evt) {
		if (evt.err.source) {
			this.writeLine('  ' + colors.errorSource(`${evt.err.source.file}:${evt.err.source.line}`));
			const excerpt = codeExcerpt(evt.err.source, {maxWidth: this.stream.columns});
			if (excerpt) {
				this.writeLine();
				this.writeLine(indentString(excerpt, 2));
			}
		}

		if (evt.err.avaAssertionError) {
			const result = formatSerializedError(evt.err);
			if (result.printMessage) {
				this.writeLine();
				this.writeLine(indentString(evt.err.message, 2));
			}

			if (result.formatted) {
				this.writeLine();
				this.writeLine(indentString(result.formatted, 2));
			}

			const message = improperUsageMessages.forError(evt.err);
			if (message) {
				this.writeLine();
				this.writeLine(indentString(message, 2));
			}
		} else if (evt.err.nonErrorObject) {
			this.writeLine(indentString(trimOffNewlines(evt.err.formatted), 2));
		} else {
			this.writeLine();
			this.writeLine(indentString(evt.err.message, 2));
		}

		if (evt.err.stack) {
			const stack = evt.err.stack;
			if (stack.includes('\n')) {
				this.writeLine();
				this.writeLine(indentString(colors.errorStack(stack), 2));
			}
		}
	}

	writeLogs(evt) {
		if (evt.logs) {
			for (const log of evt.logs) {
				const logLines = indentString(colors.log(log), 6);
				const logLinesWithLeadingFigure = logLines.replace(
					/^ {6}/,
					`    ${colors.information(figures.info)} `
				);
				this.writeLine(logLinesWithLeadingFigure);
			}
		}
	}

	writeTestSummary(evt) {
		if (evt.type === 'hook-failed' || evt.type === 'test-failed') {
			this.writeLine(`  ${colors.error(figures.cross)} ${this.prefixTitle(evt.testFile, evt.title)} ${colors.error(evt.err.message)}`);
		} else if (evt.knownFailing) {
			this.writeLine(`  ${colors.error(figures.tick)} ${colors.error(this.prefixTitle(evt.testFile, evt.title))}`);
		} else {
			// Display duration only over a threshold
			const threshold = 100;
			const duration = evt.duration > threshold ? colors.duration(' (' + prettyMs(evt.duration) + ')') : '';

			this.writeLine(`  ${colors.pass(figures.tick)} ${this.prefixTitle(evt.testFile, evt.title)}${duration}`);
		}

		this.writeLogs(evt);
	}

	writeFailure(evt) {
		this.writeLine(`  ${colors.title(this.prefixTitle(evt.testFile, evt.title))}`);
		this.writeLogs(evt);
		this.writeLine();
		this.writeErr(evt);
	}

	endRun() { // eslint-disable-line complexity
		if (!this.stats) {
			this.writeLine(colors.error(`  ${figures.cross} Couldn't find any files to test`));
			this.writeLine();
			return;
		}

		if (this.matching && this.stats.selectedTests === 0) {
			this.writeLine(colors.error(`  ${figures.cross} Couldn't find any matching tests`));
			this.writeLine();
			return;
		}

		this.writeLine();

		let firstLinePostfix = this.watching ?
			' ' + chalk.gray.dim('[' + new Date().toLocaleTimeString('en-US', {hour12: false}) + ']') :
			'';

		if (this.stats.failedHooks > 0) {
			this.writeLine('  ' + colors.error(`${this.stats.failedHooks} ${plur('hook', this.stats.failedHooks)} failed`) + firstLinePostfix);
			firstLinePostfix = '';
		}
		if (this.stats.failedTests > 0) {
			this.writeLine('  ' + colors.error(`${this.stats.failedTests} ${plur('test', this.stats.failedTests)} failed`) + firstLinePostfix);
			firstLinePostfix = '';
		}
		if (this.stats.failedHooks === 0 && this.stats.failedTests === 0 && this.stats.passedTests > 0) {
			this.writeLine('  ' + colors.pass(`${this.stats.passedTests} ${plur('test', this.stats.passedTests)} passed`) + firstLinePostfix);
			firstLinePostfix = '';
		}
		if (this.stats.passedKnownFailingTests > 0) {
			this.writeLine('  ' + colors.error(`${this.stats.passedKnownFailingTests} ${plur('known failure', this.stats.passedKnownFailingTests)}`));
		}
		if (this.stats.skippedTests > 0) {
			this.writeLine('  ' + colors.skip(`${this.stats.skippedTests} ${plur('test', this.stats.skippedTests)} skipped`));
		}
		if (this.stats.todoTests > 0) {
			this.writeLine('  ' + colors.todo(`${this.stats.todoTests} ${plur('test', this.stats.todoTests)} todo`));
		}
		if (this.stats.unhandledRejections > 0) {
			this.writeLine('  ' + colors.error(`${this.stats.unhandledRejections} unhandled ${plur('rejection', this.stats.unhandledRejections)}`));
		}
		if (this.stats.uncaughtExceptions > 0) {
			this.writeLine('  ' + colors.error(`${this.stats.uncaughtExceptions} uncaught ${plur('exception', this.stats.uncaughtExceptions)}`));
		}
		if (this.previousFailures > 0) {
			this.writeLine('  ' + colors.error(`${this.previousFailures} previous ${plur('failure', this.previousFailures)} in test files that were not rerun`));
		}

		if (this.stats.passedKnownFailingTests > 0) {
			this.writeLine();
			for (const evt of this.knownFailures) {
				this.writeLine('  ' + colors.error(this.prefixTitle(evt.testFile, evt.title)));
			}
		}

		const shouldWriteFailFastDisclaimer = this.failFastEnabled && (this.stats.remainingTests > 0 || this.stats.files > this.stats.finishedWorkers);

		if (this.failures.length > 0) {
			this.writeLine();

			const lastFailure = this.failures[this.failures.length - 1];
			for (const evt of this.failures) {
				this.writeFailure(evt);
				if (evt !== lastFailure || shouldWriteFailFastDisclaimer) {
					this.writeLine();
					this.writeLine();
					this.writeLine();
				}
			}
		}

		if (shouldWriteFailFastDisclaimer) {
			let remaining = '';
			if (this.stats.remainingTests > 0) {
				remaining += `At least ${this.stats.remainingTests} ${plur('test was', 'tests were', this.stats.remainingTests)} skipped`;
				if (this.stats.files > this.stats.finishedWorkers) {
					remaining += ', as well as ';
				}
			}
			if (this.stats.files > this.stats.finishedWorkers) {
				const skippedFileCount = this.stats.files - this.stats.finishedWorkers;
				remaining += `${skippedFileCount} ${plur('test file', 'test files', skippedFileCount)}`;
				if (this.stats.remainingTests === 0) {
					remaining += ` ${plur('was', 'were', skippedFileCount)} skipped`;
				}
			}
			this.writeLine('  ' + colors.information(`\`--fail-fast\` is on. ${remaining}.`));
		}

		this.writeLine();
	}
}

module.exports = VerboseReporter;
