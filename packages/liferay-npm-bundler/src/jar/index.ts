/**
 * SPDX-FileCopyrightText: © 2017 Liferay, Inc. <https://liferay.com>
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import fs from 'fs-extra';
import globby, {GlobbyOptions} from 'globby';
import JSZip from 'jszip';
import {
	ConfigurationJson,
	FilePath,
	PortletInstanceConfiguration,
	SystemConfiguration,
} from 'liferay-js-toolkit-core';
import path from 'path';

import {buildBundlerDir, project} from '../globals';
import * as ddm from './ddm';
import * as xml from './xml';

const pkgJson = project.pkgJson;

/**
 * Create an OSGi bundle with build's output
 */
export default function createJar(): Promise<void> {
	const zip: JSZip = new JSZip();

	addManifest(zip);
	addBuildFiles(zip);
	addLocalizationFiles(zip);
	addSystemConfigurationFiles(zip);
	addPortletInstanceConfigurationFile(zip);

	return zip.generateAsync({type: 'nodebuffer'}).then((buffer) => {
		fs.mkdirpSync(project.jar.outputDir.asNative);

		fs.writeFileSync(
			project.jar.outputDir.join(project.jar.outputFilename).asNative,
			buffer
		);
	});
}

/**
 * Add build's output files to ZIP archive
 */
function addBuildFiles(zip: JSZip): void {
	addFiles(
		buildBundlerDir.asNative,
		['**/*', `!${project.jar.outputFilename}`],
		zip.folder('META-INF').folder('resources')
	);
}

/**
 * Add several files to a ZIP folder.
 * @param srcDirPath source folder
 * @param srcGlobs
 * array of globs describing files to include (in globby, i.e. POSIX, format)
 * @param destFolder the destination folder in the ZIP file
 */
function addFiles(
	srcDirPath: string,
	srcGlobs: string[],
	destFolder: JSZip
): void {
	const filePaths = globby
		.sync(srcGlobs, {
			cwd: srcDirPath,
			nodir: true,
		} as GlobbyOptions)
		.map((posixPath) => new FilePath(posixPath, {posix: true}))
		.map((file) => file.asNative);

	filePaths.forEach((filePath) => {
		const parts = filePath.split(path.sep);
		const dirs = parts.slice(0, parts.length - 1);
		const name = parts[parts.length - 1];

		const folder = dirs.reduce(
			(folder, dir) => folder.folder(dir),
			destFolder
		);

		folder.file(name, fs.readFileSync(path.join(srcDirPath, filePath)));
	});
}

/**
 * Add the localization bundle files if configured.
 */
function addLocalizationFiles(zip: JSZip): void {
	const languageFileBaseName = project.l10n.languageFileBaseName;

	if (languageFileBaseName) {
		const localizationDirPath = path.dirname(languageFileBaseName.asNative);

		addFiles(localizationDirPath, ['**/*'], zip.folder('content'));
	}
}

/**
 * Add the manifest file to the ZIP archive
 */
function addManifest(zip: JSZip): void {
	let contents = '';

	const bundlerVersion = project.versionsInfo.get('liferay-npm-bundler')
		.version;

	contents += `Manifest-Version: 1.0\n`;
	contents += `Bundle-ManifestVersion: 2\n`;

	contents += `Tool: liferay-npm-bundler-${bundlerVersion}\n`;

	contents += `Bundle-SymbolicName: ${pkgJson.name}\n`;
	contents += `Bundle-Version: ${pkgJson.version}\n`;
	if (pkgJson.description) {
		contents += `Bundle-Name: ${pkgJson.description}\n`;
	}

	contents += `Web-ContextPath: ${project.jar.webContextPath}\n`;

	contents +=
		`Provide-Capability: osgi.webresource;` +
		`osgi.webresource=${pkgJson.name};` +
		`version:Version="${pkgJson.version}"\n`;

	if (project.l10n.supported) {
		const bundleName = path.basename(
			project.l10n.languageFileBaseName.asNative
		);

		contents += `Provide-Capability: liferay.resource.bundle;`;
		contents += `resource.bundle.base.name="content.${bundleName}"\n`;
	}

	if (project.jar.requireJsExtender) {
		let filter;

		const minimumExtenderVersion = getMinimumExtenderVersion();

		if (minimumExtenderVersion) {
			filter =
				`(&` +
				`(osgi.extender=liferay.frontend.js.portlet)` +
				`(version>=${minimumExtenderVersion})` +
				`)`;
		} else {
			filter = `(osgi.extender=liferay.frontend.js.portlet)`;
		}

		contents += `Require-Capability: osgi.extender;filter:="${filter}"\n`;
	}

	Object.entries(project.jar.customManifestHeaders).forEach(
		([key, value]) => {
			contents += `${key}: ${value}\n`;
		}
	);

	zip.folder('META-INF').file('MANIFEST.MF', contents);
}

/**
 * Add the settings files if configured.
 */
function addSystemConfigurationFiles(zip: JSZip): void {
	const systemConfigJson = getSystemConfigurationJson();

	if (!systemConfigJson) {
		return;
	}

	// Add OSGI-INF/metatype/metatype.xml file
	const localization = project.l10n.supported
		? `content/${path.basename(project.l10n.languageFileBaseName.asNative)}`
		: undefined;

	const name =
		systemConfigJson.name ||
		(localization ? pkgJson.name : pkgJson.description || pkgJson.name);

	const metatype = xml.createMetatype(pkgJson.name, name);

	if (localization) {
		xml.addMetatypeLocalization(metatype, localization);
	}

	const fields = Object.entries(systemConfigJson.fields);

	fields.forEach(([id, desc]) => {
		xml.addMetatypeAttr(metatype, id, desc);
	});

	zip.folder('OSGI-INF')
		.folder('metatype')
		.file(`${pkgJson.name}.xml`, xml.format(metatype));

	// Add features/metatype.json file
	const metatypeJson = {};

	if (systemConfigJson.category) {
		metatypeJson['category'] = systemConfigJson.category;
	}

	zip.folder('features').file(
		'metatype.json',
		JSON.stringify(metatypeJson, null, 2)
	);
}

/**
 * Add the portlet preferences file if configured.
 */
function addPortletInstanceConfigurationFile(zip: JSZip): void {
	const portletInstanceConfigJson = getPortletInstanceConfigurationJson();

	if (!portletInstanceConfigJson) {
		return;
	}

	const ddmJson = ddm.transformPreferences(
		project,
		portletInstanceConfigJson
	);

	zip.folder('features').file(
		'portlet_preferences.json',
		JSON.stringify(ddmJson, null, 2)
	);
}

/**
 * Get the minimum extender version needed for the capabilities of this bundle
 * to work
 *
 * @return a version number or undefined if none is required
 */
function getMinimumExtenderVersion(): string | undefined {
	const requireJsExtender = project.jar.requireJsExtender;

	if (typeof requireJsExtender === 'string') {
		if (requireJsExtender === 'any') {
			return undefined;
		}

		return requireJsExtender;
	}

	let minExtenderMinorVersion = 0;

	if (getSystemConfigurationJson()) {
		minExtenderMinorVersion = Math.max(minExtenderMinorVersion, 1);
	}

	if (getPortletInstanceConfigurationJson()) {
		minExtenderMinorVersion = Math.max(minExtenderMinorVersion, 1);
	}

	return `1.${minExtenderMinorVersion}.0`;
}

/**
 * Get portlet instance configuration JSON object from getConfigurationFile()
 * file.
 */
function getPortletInstanceConfigurationJson(): PortletInstanceConfiguration {
	if (!project.jar.configurationFile) {
		return undefined;
	}

	const filePath = project.jar.configurationFile.asNative;
	const configurationJson: ConfigurationJson = fs.readJSONSync(filePath);

	if (
		!configurationJson.portletInstance ||
		!configurationJson.portletInstance.fields ||
		Object.keys(configurationJson.portletInstance.fields).length === 0
	) {
		return undefined;
	}

	return configurationJson.portletInstance;
}

/**
 * Get system configuration JSON object from getConfigurationFile() file.
 * @return {object}
 */
function getSystemConfigurationJson(): SystemConfiguration {
	if (!project.jar.configurationFile) {
		return undefined;
	}

	const filePath = project.jar.configurationFile.asNative;
	const configurationJson: ConfigurationJson = fs.readJSONSync(filePath);

	if (
		!configurationJson.system ||
		!configurationJson.system.fields ||
		Object.keys(configurationJson.system.fields).length === 0
	) {
		return undefined;
	}

	return configurationJson.system;
}
