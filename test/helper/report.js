'use strict';
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const globby = require('globby');
const proxyquire = require('proxyquire');
const replaceString = require('replace-string');
const Logger = require('../../lib/logger');

const Api = proxyquire('../../api', {
	'./lib/fork': proxyquire('../../lib/fork', {
		child_process: Object.assign({}, childProcess, { // eslint-disable-line camelcase
			fork(filename, argv, options) {
				return childProcess.fork(path.join(__dirname, 'report-worker.js'), argv, options);
			}
		})
	})
});

exports.assert = (t, logFile, buffer) => {
	let existing = null;
	try {
		existing = fs.readFileSync(logFile);
	} catch (err) {}
	if (existing === null || process.env.UPDATE_REPORTER_LOG) {
		fs.writeFileSync(logFile, buffer);
		existing = buffer;
	}

	t.is(buffer.toString('utf8'), existing.toString('utf8'));
};

exports.sanitizers = {
	cwd: str => replaceString(str, process.cwd(), '~'),
	posix: str => replaceString(str, '\\', '/'),
	slow: str => str.replace(/(slow.+?)\(\d+m?s\)/g, '$1 (000ms)'),
	// TODO: Remove when Node.js 4 support is dropped
	stacks: str => str.replace(/(\[90m|')t \((.+?\.js:\d+:\d+)\)/g, '$1$2').replace(/null\._onTimeout/g, 'Timeout.setTimeout')
};

const run = (type, reporter) => {
	const projectDir = path.join(__dirname, '../fixture/report', type.toLowerCase());

	const api = new Api({
		failFast: type === 'failFast' || type === 'failFast2',
		failWithoutAssertions: false,
		serial: type === 'failFast' || type === 'failFast2',
		require: [],
		cacheEnable: true,
		compileEnhancements: true,
		explicitTitles: type === 'watch',
		match: [],
		babelConfig: {testOptions: {}},
		resolveTestsFrom: projectDir,
		projectDir,
		timeout: undefined,
		concurrency: 1,
		updateSnapshots: false,
		snapshotDir: false,
		color: true
	});

	reporter.api = api;
	const logger = new Logger(reporter);
	logger.start();

	api.on('test-run', runStatus => {
		reporter.api = runStatus;
		runStatus.on('test', logger.test);
		runStatus.on('error', logger.unhandledError);

		runStatus.on('stdout', logger.stdout);
		runStatus.on('stderr', logger.stderr);
	});

	const files = globby.sync('*.js', {cwd: projectDir}).sort();
	if (type !== 'watch') {
		return api.run(files).then(runStatus => {
			logger.finish(runStatus);
		});
	}

	// Mimick watch mode
	return api.run(files).then(runStatus => {
		logger.finish(runStatus);

		// Don't clear
		logger.reset();
		logger.section();
		logger.reset();
		logger.start();

		return api.run(files);
	}).then(runStatus => {
		runStatus.previousFailCount = 2;
		logger.finish(runStatus);

		// Clear
		logger.clear();
		logger.reset();
		logger.start();

		return api.run(files);
	}).then(runStatus => {
		logger.finish(runStatus);
	});
};

exports.regular = reporter => run('regular', reporter);
exports.failFast = reporter => run('failFast', reporter);
exports.failFast2 = reporter => run('failFast2', reporter);
exports.only = reporter => run('only', reporter);
exports.watch = reporter => run('watch', reporter);
