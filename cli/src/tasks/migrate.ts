import { writeFileSync, readFileSync, existsSync } from 'fs-extra';
import { join } from 'path';
import { rimraf } from 'rimraf';
import { coerce, gte, lt } from 'semver';

import { getAndroidPlugins } from '../android/common';
import c from '../colors';
import { getCoreVersion, runTask, checkJDKMajorVersion } from '../common';
import type { Config } from '../definitions';
import { fatal } from '../errors';
import { logger, logPrompt, logSuccess } from '../log';
import { getPlugins } from '../plugin';
import { deleteFolderRecursive } from '../util/fs';
import { resolveNode } from '../util/node';
import { runCommand } from '../util/subprocess';
import { extractTemplate } from '../util/template';

// eslint-disable-next-line prefer-const
let allDependencies: { [key: string]: any } = {};
const libs = ['@capacitor/core', '@capacitor/cli', '@capacitor/ios', '@capacitor/android'];
const plugins = [
  '@capacitor/action-sheet',
  '@capacitor/app',
  '@capacitor/app-launcher',
  '@capacitor/browser',
  '@capacitor/camera',
  '@capacitor/clipboard',
  '@capacitor/device',
  '@capacitor/dialog',
  '@capacitor/filesystem',
  '@capacitor/geolocation',
  '@capacitor/haptics',
  '@capacitor/keyboard',
  '@capacitor/local-notifications',
  '@capacitor/motion',
  '@capacitor/network',
  '@capacitor/preferences',
  '@capacitor/push-notifications',
  '@capacitor/screen-reader',
  '@capacitor/screen-orientation',
  '@capacitor/share',
  '@capacitor/splash-screen',
  '@capacitor/status-bar',
  '@capacitor/text-zoom',
  '@capacitor/toast',
];
const coreVersion = '^7.0.0';
const pluginVersion = '^7.0.0';
const gradleVersion = '8.11.1';
let installFailed = false;

export async function migrateCommand(config: Config, noprompt: boolean, packagemanager: string): Promise<void> {
  if (config === null) {
    fatal('Config data missing');
  }

  const capMajor = await checkCapacitorMajorVersion(config);
  if (capMajor < 6) {
    fatal('Migrate can only be used on Capacitor 6, please use the CLI in Capacitor 6 to upgrade to 6 first');
  }

  const jdkMajor = await checkJDKMajorVersion();

  if (jdkMajor < 21) {
    logger.warn('Capacitor 7 requires JDK 21 or higher. Some steps may fail.');
  }

  const variablesAndClasspaths:
    | {
        variables: any;
        'com.android.tools.build:gradle': string;
        'com.google.gms:google-services': string;
      }
    | undefined = await getAndroidVariablesAndClasspaths(config);

  if (!variablesAndClasspaths) {
    fatal('Variable and Classpath info could not be read.');
  }

  allDependencies = {
    ...config.app.package.dependencies,
    ...config.app.package.devDependencies,
  };

  const monorepoWarning =
    'Please note this tool is not intended for use in a mono-repo environment, please check out the Ionic vscode extension for this functionality.';

  logger.info(monorepoWarning);

  const { migrateconfirm } = noprompt
    ? { migrateconfirm: 'y' }
    : await logPrompt(`Capacitor 7 sets a deployment target of iOS 14 and Android 15 (SDK 35). \n`, {
        type: 'text',
        name: 'migrateconfirm',
        message: `Are you sure you want to migrate? (Y/n)`,
        initial: 'y',
      });

  if (typeof migrateconfirm === 'string' && migrateconfirm.toLowerCase() === 'y') {
    try {
      const { depInstallConfirm } = noprompt
        ? { depInstallConfirm: 'y' }
        : await logPrompt(
            `Would you like the migrator to run npm, yarn, pnpm, or bun install to install the latest versions of capacitor packages? (Those using other package managers should answer N)`,
            {
              type: 'text',
              name: 'depInstallConfirm',
              message: `Run Dependency Install? (Y/n)`,
              initial: 'y',
            },
          );

      const runNpmInstall = typeof depInstallConfirm === 'string' && depInstallConfirm.toLowerCase() === 'y';

      let installerType = 'npm';
      if (runNpmInstall) {
        const { manager } = packagemanager
          ? { manager: packagemanager }
          : await logPrompt('What dependency manager do you use?', {
              type: 'select',
              name: 'manager',
              message: `Dependency Management Tool`,
              choices: [
                { title: 'NPM', value: 'npm' },
                { title: 'Yarn', value: 'yarn' },
                { title: 'PNPM', value: 'pnpm' },
                { title: 'Bun', value: 'bun' },
              ],
              initial: 0,
            });
        installerType = manager;
      }

      try {
        await runTask(`Installing Latest Modules using ${installerType}.`, () => {
          return installLatestLibs(installerType, runNpmInstall, config);
        });
      } catch (ex) {
        logger.error(
          `${installerType} install failed. Try deleting node_modules folder and running ${c.input(
            `${installerType} install --force`,
          )} manually.`,
        );
        installFailed = true;
      }

      // Update iOS Projects
      if (allDependencies['@capacitor/ios'] && existsSync(config.ios.platformDirAbs)) {
        // ios template changes
        // Set deployment target to 14.0
        await runTask(`Migrating deployment target to 14.0.`, () => {
          return updateFile(
            config,
            join(config.ios.nativeXcodeProjDirAbs, 'project.pbxproj'),
            'IPHONEOS_DEPLOYMENT_TARGET = ',
            ';',
            '14.0',
          );
        });
        // Update Podfile to 14.0
        await runTask(`Migrating Podfile to 14.0.`, () => {
          return updateFile(config, join(config.ios.nativeProjectDirAbs, 'Podfile'), `platform :ios, '`, `'`, '14.0');
        });
      }

      if (!installFailed) {
        await runTask(`Running cap sync.`, () => {
          return runCommand('npx', ['cap', 'sync']);
        });
      } else {
        logger.warn('Skipped Running cap sync.');
      }

      if (allDependencies['@capacitor/android'] && existsSync(config.android.platformDirAbs)) {
        // AndroidManifest.xml add navigation"
        await runTask(`Migrating AndroidManifest.xml by adding navigation to Activity configChanges.`, () => {
          return updateAndroidManifest(join(config.android.srcMainDirAbs, 'AndroidManifest.xml'));
        });

        const gradleWrapperVersion = getGradleWrapperVersion(
          join(config.android.platformDirAbs, 'gradle', 'wrapper', 'gradle-wrapper.properties'),
        );

        if (!installFailed && gte(gradleVersion, gradleWrapperVersion)) {
          try {
            await runTask(`Upgrading gradle wrapper`, () => {
              return updateGradleWrapperFiles(config.android.platformDirAbs);
            });
            // Run twice as first time it only updates the wrapper properties file
            await runTask(`Upgrading gradle wrapper files`, () => {
              return updateGradleWrapperFiles(config.android.platformDirAbs);
            });
          } catch (e: any) {
            if (e.includes('EACCES')) {
              logger.error(
                `gradlew file does not have executable permissions. This can happen if the Android platform was added on a Windows machine. Please run ${c.input(
                  `chmod +x ./${config.android.platformDir}/gradlew`,
                )} and ${c.input(
                  `cd ${config.android.platformDir} && ./gradlew wrapper --distribution-type all --gradle-version ${gradleVersion} --warning-mode all`,
                )} to update the files manually`,
              );
            } else {
              logger.error(`gradle wrapper files were not updated`);
            }
          }
        } else {
          logger.warn('Skipped upgrading gradle wrapper files');
        }
        await runTask(`Migrating build.gradle file.`, () => {
          return updateBuildGradle(join(config.android.platformDirAbs, 'build.gradle'), variablesAndClasspaths);
        });

        // Variables gradle
        await runTask(`Migrating variables.gradle file.`, () => {
          return (async (): Promise<void> => {
            const variablesPath = join(config.android.platformDirAbs, 'variables.gradle');
            let txt = readFile(variablesPath);
            if (!txt) {
              return;
            }
            txt = txt.replace(/= {2}'/g, `= '`);
            writeFileSync(variablesPath, txt, { encoding: 'utf-8' });
            for (const variable of Object.keys(variablesAndClasspaths.variables)) {
              let replaceStart = `${variable} = '`;
              let replaceEnd = `'\n`;
              if (typeof variablesAndClasspaths.variables[variable] === 'number') {
                replaceStart = `${variable} = `;
                replaceEnd = `\n`;
              }

              if (txt.includes(replaceStart)) {
                const first = txt.indexOf(replaceStart) + replaceStart.length;
                const value = txt.substring(first, txt.indexOf(replaceEnd, first));
                if (
                  (typeof variablesAndClasspaths.variables[variable] === 'number' &&
                    value <= variablesAndClasspaths.variables[variable]) ||
                  (typeof variablesAndClasspaths.variables[variable] === 'string' &&
                    lt(value, variablesAndClasspaths.variables[variable]))
                ) {
                  await updateFile(
                    config,
                    variablesPath,
                    replaceStart,
                    replaceEnd,
                    variablesAndClasspaths.variables[variable].toString(),
                    true,
                  );
                }
              } else {
                let file = readFile(variablesPath);
                if (file) {
                  file = file.replace(
                    '}',
                    `    ${replaceStart}${variablesAndClasspaths.variables[variable].toString()}${replaceEnd}}`,
                  );
                  writeFileSync(variablesPath, file);
                }
              }
            }
            const pluginVariables: { [key: string]: string } = {
              firebaseMessagingVersion: '24.1.0',
              playServicesLocationVersion: '21.3.0',
              androidxBrowserVersion: '1.8.0',
              androidxMaterialVersion: '1.12.0',
              androidxExifInterfaceVersion: '1.3.7',
              androidxCoreKTXVersion: '1.12.0',
              googleMapsPlayServicesVersion: '18.2.0',
              googleMapsUtilsVersion: '3.8.2',
              googleMapsKtxVersion: '5.0.0',
              googleMapsUtilsKtxVersion: '5.0.0',
              kotlinxCoroutinesVersion: '1.7.3',
              coreSplashScreenVersion: '1.0.1',
            };
            for (const variable of Object.keys(pluginVariables)) {
              await updateFile(config, variablesPath, `${variable} = '`, `'`, pluginVariables[variable], true);
            }
          })();
        });

        rimraf.sync(join(config.android.appDirAbs, 'build'));

        if (!installFailed) {
          await runTask('Migrating package from Manifest to build.gradle in Capacitor plugins', () => {
            return patchOldCapacitorPlugins(config);
          });
        } else {
          logger.warn('Skipped migrating package from Manifest to build.gradle in Capacitor plugins');
        }
      }

      // Write all breaking changes
      await runTask(`Writing breaking changes.`, () => {
        return writeBreakingChanges();
      });

      if (!installFailed) {
        logSuccess(`Migration to Capacitor ${coreVersion} is complete. Run and test your app!`);
      } else {
        logger.warn(
          `Migration to Capacitor ${coreVersion} is incomplete. Check the log messages for more information.`,
        );
      }
    } catch (err) {
      fatal(`Failed to migrate: ${err}`);
    }
  } else {
    fatal(`User canceled migration.`);
  }
}

async function checkCapacitorMajorVersion(config: Config): Promise<number> {
  const capacitorVersion = await getCoreVersion(config);
  const versionArray = capacitorVersion.match(/([0-9]+)\.([0-9]+)\.([0-9]+)/) ?? [];
  const majorVersion = parseInt(versionArray[1]);
  return majorVersion;
}

async function installLatestLibs(dependencyManager: string, runInstall: boolean, config: Config) {
  const pkgJsonPath = join(config.app.rootDir, 'package.json');
  const pkgJsonFile = readFile(pkgJsonPath);
  if (!pkgJsonFile) {
    return;
  }
  const pkgJson: any = JSON.parse(pkgJsonFile);

  for (const devDepKey of Object.keys(pkgJson['devDependencies'] || {})) {
    if (libs.includes(devDepKey)) {
      pkgJson['devDependencies'][devDepKey] = coreVersion;
    } else if (plugins.includes(devDepKey)) {
      pkgJson['devDependencies'][devDepKey] = pluginVersion;
    }
  }
  for (const depKey of Object.keys(pkgJson['dependencies'] || {})) {
    if (libs.includes(depKey)) {
      pkgJson['dependencies'][depKey] = coreVersion;
    } else if (plugins.includes(depKey)) {
      pkgJson['dependencies'][depKey] = pluginVersion;
    }
  }

  writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2), {
    encoding: 'utf-8',
  });

  if (runInstall) {
    rimraf.sync(join(config.app.rootDir, 'node_modules/@capacitor/!(cli)'));
    await runCommand(dependencyManager, ['install']);
    if (dependencyManager == 'yarn') {
      await runCommand(dependencyManager, ['upgrade']);
    } else {
      await runCommand(dependencyManager, ['update']);
    }
  } else {
    logger.info(`Please run an install command with your package manager of choice. (ex: yarn install)`);
  }
}

async function writeBreakingChanges() {
  const breaking = [
    '@capacitor/app',
    '@capacitor/device',
    '@capacitor/haptics',
    '@capacitor/splash-screen',
    '@capacitor/statusbar',
  ];
  const broken = [];
  for (const lib of breaking) {
    if (allDependencies[lib]) {
      broken.push(lib);
    }
  }
  if (broken.length > 0) {
    logger.info(
      `IMPORTANT: Review https://capacitorjs.com/docs/next/updating/7-0#plugins for breaking changes in these plugins that you use: ${broken.join(
        ', ',
      )}.`,
    );
  }
}

async function getAndroidVariablesAndClasspaths(config: Config) {
  const tempAndroidTemplateFolder = join(config.cli.assetsDirAbs, 'tempAndroidTemplate');
  await extractTemplate(config.cli.assets.android.platformTemplateArchiveAbs, tempAndroidTemplateFolder);
  const variablesGradleFile = readFile(join(tempAndroidTemplateFolder, 'variables.gradle'));
  const buildGradleFile = readFile(join(tempAndroidTemplateFolder, 'build.gradle'));
  if (!variablesGradleFile || !buildGradleFile) {
    return;
  }
  deleteFolderRecursive(tempAndroidTemplateFolder);

  const firstIndxOfCATBGV = buildGradleFile.indexOf(`classpath 'com.android.tools.build:gradle:`) + 42;
  const firstIndxOfCGGGS = buildGradleFile.indexOf(`com.google.gms:google-services:`) + 31;
  const comAndroidToolsBuildGradleVersion =
    '' + buildGradleFile.substring(firstIndxOfCATBGV, buildGradleFile.indexOf("'", firstIndxOfCATBGV));
  const comGoogleGmsGoogleServices =
    '' + buildGradleFile.substring(firstIndxOfCGGGS, buildGradleFile.indexOf("'", firstIndxOfCGGGS));

  const variablesGradleAsJSON = JSON.parse(
    variablesGradleFile
      .replace('ext ', '')
      .replace(/=/g, ':')
      .replace(/\n/g, ',')
      .replace(/,([^:]+):/g, function (_k, p1) {
        return `,"${p1}":`;
      })
      .replace('{,', '{')
      .replace(',}', '}')
      .replace(/\s/g, '')
      .replace(/'/g, '"'),
  );

  return {
    variables: variablesGradleAsJSON,
    'com.android.tools.build:gradle': comAndroidToolsBuildGradleVersion,
    'com.google.gms:google-services': comGoogleGmsGoogleServices,
  };
}

function readFile(filename: string): string | undefined {
  try {
    if (!existsSync(filename)) {
      logger.error(`Unable to find ${filename}. Try updating it manually`);
      return;
    }
    return readFileSync(filename, 'utf-8');
  } catch (err) {
    logger.error(`Unable to read ${filename}. Verify it is not already open. ${err}`);
  }
}

function getGradleWrapperVersion(filename: string): string {
  const txt = readFile(filename);
  if (!txt) {
    return '0.0.0';
  }
  const version = txt.substring(txt.indexOf('gradle-') + 7, txt.indexOf('-all.zip'));
  const semverVersion = coerce(version)?.version;
  return semverVersion ? semverVersion : '0.0.0';
}

async function updateGradleWrapperFiles(platformDir: string) {
  await runCommand(
    `./gradlew`,
    ['wrapper', '--distribution-type', 'all', '--gradle-version', gradleVersion, '--warning-mode', 'all'],
    {
      cwd: platformDir,
    },
  );
}

async function movePackageFromManifestToBuildGradle(manifestFilename: string, buildGradleFilename: string) {
  const manifestText = readFile(manifestFilename);
  const buildGradleText = readFile(buildGradleFilename);

  if (!manifestText) {
    logger.error(`Could not read ${manifestFilename}. Check its permissions and if it exists.`);
    return;
  }

  if (!buildGradleText) {
    logger.error(`Could not read ${buildGradleFilename}. Check its permissions and if it exists.`);
    return;
  }

  const namespaceExists = new RegExp(/\s+namespace\s+/).test(buildGradleText);
  if (namespaceExists) {
    logger.error('Found namespace in build.gradle already, skipping migration');
    return;
  }

  let packageName: string;
  const manifestRegEx = new RegExp(/package="([^"]+)"/);
  const manifestResults = manifestRegEx.exec(manifestText);

  if (manifestResults === null) {
    logger.error(`Unable to update Android Manifest. Package not found.`);
    return;
  } else {
    packageName = manifestResults[1];
  }

  let manifestReplaced = manifestText;

  manifestReplaced = manifestReplaced.replace(manifestRegEx, '');

  if (manifestText == manifestReplaced) {
    logger.error(`Unable to update Android Manifest: no changes were detected in Android Manifest file`);
    return;
  }

  let buildGradleReplaced = buildGradleText;

  buildGradleReplaced = setAllStringIn(buildGradleText, 'android {', '\n', `\n    namespace "${packageName}"`);

  if (buildGradleText == buildGradleReplaced) {
    logger.error(`Unable to update buildGradleText: no changes were detected in Android Manifest file`);
    return;
  }

  writeFileSync(manifestFilename, manifestReplaced, 'utf-8');
  writeFileSync(buildGradleFilename, buildGradleReplaced, 'utf-8');
}

async function updateBuildGradle(
  filename: string,
  variablesAndClasspaths: {
    variables: any;
    'com.android.tools.build:gradle': string;
    'com.google.gms:google-services': string;
  },
) {
  const txt = readFile(filename);
  if (!txt) {
    return;
  }
  const neededDeps: { [key: string]: string } = {
    'com.android.tools.build:gradle': variablesAndClasspaths['com.android.tools.build:gradle'],
    'com.google.gms:google-services': variablesAndClasspaths['com.google.gms:google-services'],
  };
  let replaced = txt;

  for (const dep of Object.keys(neededDeps)) {
    if (replaced.includes(`classpath '${dep}`)) {
      const firstIndex = replaced.indexOf(dep) + dep.length + 1;
      const existingVersion = '' + replaced.substring(firstIndex, replaced.indexOf("'", firstIndex));
      if (gte(neededDeps[dep], existingVersion)) {
        replaced = setAllStringIn(replaced, `classpath '${dep}:`, `'`, neededDeps[dep]);
        logger.info(`Set ${dep} = ${neededDeps[dep]}.`);
      }
    }
  }
  writeFileSync(filename, replaced, 'utf-8');
}

async function updateFile(
  config: Config,
  filename: string,
  textStart: string,
  textEnd: string,
  replacement?: string,
  skipIfNotFound?: boolean,
): Promise<boolean> {
  if (config === null) {
    return false;
  }
  const path = filename;
  let txt = readFile(path);
  if (!txt) {
    return false;
  }
  if (txt.includes(textStart)) {
    if (replacement) {
      txt = setAllStringIn(txt, textStart, textEnd, replacement);
      writeFileSync(path, txt, { encoding: 'utf-8' });
    } else {
      // Replacing in code so we need to count the number of brackets to find the end of the function in swift
      const lines = txt.split('\n');
      let replaced = '';
      let keep = true;
      let brackets = 0;
      for (const line of lines) {
        if (line.includes(textStart)) {
          keep = false;
        }
        if (!keep) {
          brackets += (line.match(/{/g) || []).length;
          brackets -= (line.match(/}/g) || []).length;
          if (brackets == 0) {
            keep = true;
          }
        } else {
          replaced += line + '\n';
        }
      }
      writeFileSync(path, replaced, { encoding: 'utf-8' });
    }
    return true;
  } else if (!skipIfNotFound) {
    logger.error(`Unable to find "${textStart}" in ${filename}. Try updating it manually`);
  }

  return false;
}

function setAllStringIn(data: string, start: string, end: string, replacement: string): string {
  let position = 0;
  let result = data;
  let replaced = true;
  while (replaced) {
    const foundIdx = result.indexOf(start, position);
    if (foundIdx == -1) {
      replaced = false;
    } else {
      const idx = foundIdx + start.length;
      position = idx + replacement.length;
      result = result.substring(0, idx) + replacement + result.substring(result.indexOf(end, idx));
    }
  }
  return result;
}

async function updateAndroidManifest(filename: string) {
  const txt = readFile(filename);
  if (!txt) {
    return;
  }

  if (txt.includes('navigation')) {
    return; // Probably already updated
  }
  const replaced = txt.replace(
    'android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode"',
    'android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode|navigation"',
  );

  writeFileSync(filename, replaced, 'utf-8');
}

export async function patchOldCapacitorPlugins(config: Config): Promise<void[]> {
  const allPlugins = await getPlugins(config, 'android');
  const androidPlugins = await getAndroidPlugins(allPlugins);
  return await Promise.all(
    androidPlugins.map(async (p) => {
      if (p.manifest?.android?.src) {
        const buildGradlePath = resolveNode(config.app.rootDir, p.id, p.manifest.android.src, 'build.gradle');
        const manifestPath = resolveNode(
          config.app.rootDir,
          p.id,
          p.manifest.android.src,
          'src',
          'main',
          'AndroidManifest.xml',
        );
        if (buildGradlePath && manifestPath) {
          const gradleContent = readFile(buildGradlePath);
          if (!gradleContent?.includes('namespace')) {
            if (plugins.includes(p.id)) {
              logger.warn(
                `You are using an outdated version of ${p.id}, update the plugin to version ${pluginVersion}`,
              );
            } else {
              logger.warn(
                `${p.id}@${p.version} doesn't officially support Capacitor ${coreVersion} yet, doing our best moving it's package to build.gradle so it builds`,
              );
            }
            movePackageFromManifestToBuildGradle(manifestPath, buildGradlePath);
          }
        }
      }
    }),
  );
}
