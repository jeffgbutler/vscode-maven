// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import * as fse from "fs-extra";
import * as http from "http";
import * as md5 from "md5";
import * as minimatch from "minimatch";
import * as os from "os";
import * as path from "path";
import { ExtensionContext, extensions, workspace } from 'vscode';
import * as xml2js from "xml2js";
import { Archetype } from "./model/Archetype";
import { ProjectItem } from "./model/ProjectItem";
import { IArchetype, IArchetypeCatalogRoot, IArchetypes, IPomRoot } from "./model/XmlSchema";

export namespace Utils {
    let EXTENSION_PUBLISHER: string;
    let EXTENSION_NAME: string;
    let EXTENSION_VERSION: string;
    let EXTENSION_AI_KEY: string;

    export async function loadPackageInfo(context: ExtensionContext): Promise<void> {
        const { publisher, name, version, aiKey } = await fse.readJSON(context.asAbsolutePath("./package.json"));
        EXTENSION_AI_KEY = aiKey;
        EXTENSION_PUBLISHER = publisher;
        EXTENSION_NAME = name;
        EXTENSION_VERSION = version;
    }

    export function getExtensionPublisher(): string {
        return EXTENSION_PUBLISHER;
    }

    export function getExtensionName(): string {
        return EXTENSION_NAME;
    }

    export function getExtensionId(): string {
        return `${EXTENSION_PUBLISHER}.${EXTENSION_NAME}`;
    }

    export function getExtensionVersion(): string {
        return EXTENSION_VERSION;
    }

    export function getAiKey(): string {
        return EXTENSION_AI_KEY;
    }

    export function getTempFolderPath(...args: string[]): string {
        return path.join(os.tmpdir(), EXTENSION_NAME, ...args);
    }

    export function getPathToExtensionRoot(...args: string[]): string {
        return path.join(extensions.getExtension(getExtensionId()).extensionPath, ...args);
    }

    export async function getProject(absolutePath: string, workspacePath: string): Promise<ProjectItem> {
        if (await fse.pathExists(absolutePath)) {
            const xml: string = await fse.readFile(absolutePath, "utf8");
            const pom: IPomRoot = await readXmlContent(xml);
            if (pom && pom.project && pom.project.artifactId) {
                const artifactId: string = pom.project.artifactId.toString();
                const ret: ProjectItem = new ProjectItem(artifactId, workspacePath, absolutePath, { pom });
                ret.collapsibleState = pom.project && pom.project.modules ? 1 : 0;
                return ret;
            }
        }
        return null;
    }

    export async function readXmlContent(xml: string, options?: {}): Promise<{}> {
        const opts: {} = Object.assign({ explicitArray: true }, options);
        return new Promise<{}>(
            (resolve: (value: {}) => void, reject: (e: Error) => void): void => {
                xml2js.parseString(xml, opts, (err: Error, res: {}) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(res);
                    }
                });
            }
        );
    }

    export function withLRUItemAhead<T>(array: T[], lruItem: T): T[] {
        const ret: T[] = array.filter((elem: T) => elem !== lruItem).reverse();
        ret.push(lruItem);
        return ret.reverse();
    }

    export async function loadCmdHistory(pomXmlFilePath: string): Promise<string[]> {
        const filepath: string = getCommandHistoryCachePath(pomXmlFilePath);
        if (await fse.pathExists(filepath)) {
            const content: string = (await fse.readFile(filepath)).toString().trim();
            if (content) {
                return content.split("\n").map((line: string) => line.trim()).filter(Boolean);
            }
        }
        return [];
    }

    export async function saveCmdHistory(pomXmlFilePath: string, cmdlist: string[]): Promise<void> {
        const filepath: string = getCommandHistoryCachePath(pomXmlFilePath);
        await fse.ensureFile(filepath);
        await fse.writeFile(filepath, cmdlist.join("\n"));
    }

    export function getEffectivePomOutputPath(pomXmlFilePath: string): string {
        return path.join(os.tmpdir(), EXTENSION_NAME, md5(pomXmlFilePath), "effective-pom.xml");
    }

    export function getCommandHistoryCachePath(pomXmlFilePath: string): string {
        return path.join(os.tmpdir(), EXTENSION_NAME, md5(pomXmlFilePath), "commandHistory.txt");
    }

    export async function readFileIfExists(filepath: string): Promise<string> {
        if (await fse.pathExists(filepath)) {
            return (await fse.readFile(filepath)).toString();
        }
        return null;
    }

    export async function listArchetypeFromXml(xml: string): Promise<Archetype[]> {
        try {
            const catalogRoot: IArchetypeCatalogRoot = await readXmlContent(xml);
            if (catalogRoot && catalogRoot["archetype-catalog"]) {
                const dict: { [key: string]: Archetype } = {};
                catalogRoot["archetype-catalog"].archetypes.forEach((archetypes: IArchetypes) => {
                    archetypes.archetype.forEach((archetype: IArchetype) => {
                        const groupId: string = archetype.groupId && archetype.groupId.toString();
                        const artifactId: string = archetype.artifactId && archetype.artifactId.toString();
                        const description: string = archetype.description && archetype.description.toString();
                        const version: string = archetype.version && archetype.version.toString();
                        const repository: string = archetype.repository && archetype.repository.toString();
                        const identifier: string = `${groupId}:${artifactId}`;
                        if (!dict[identifier]) {
                            dict[identifier] =
                                new Archetype(artifactId, groupId, repository, description);
                        }
                        if (dict[identifier].versions.indexOf(version) < 0) {
                            dict[identifier].versions.push(version);
                        }
                    });
                });
                return Object.keys(dict).map((k: string) => dict[k]);
            }
        } catch (err) {
            // do nothing
        }
        return [];
    }

    export function getLocalArchetypeCatalogFilePath(): string {
        return path.join(os.homedir(), ".m2", "repository", "archetype-catalog.xml");
    }

    export function getProvidedArchetypeCatalogFilePath(): string {
        return path.join(Utils.getPathToExtensionRoot(), "resources", "archetype-catalog.xml");
    }

    export async function httpGetContent(url: string): Promise<string> {
        const filepath: string = getTempFolderPath(md5(url));
        if (await fse.pathExists(filepath)) {
            await fse.unlink(filepath);
        }
        await fse.ensureFile(filepath);
        const file: fse.WriteStream = fse.createWriteStream(filepath);
        return new Promise<string>(
            (resolve: (value: string) => void, reject: (e: Error) => void): void => {
                const request: http.ClientRequest = http.get(url, (response: http.IncomingMessage) => {
                    response.pipe(file);
                    file.on('finish', async () => {
                        file.close();
                        const buf: Buffer = await fse.readFile(filepath);
                        resolve(buf.toString());
                    });
                });
                request.on("error", (e: Error) => {
                    reject(e);
                });
            });
    }

    export async function findAllInDir(currentPath: string, targetFileName: string, depth: number, exclusion: string[] = ["**/.*"]): Promise<string[]> {
        if (exclusion) {
            for (const pattern of exclusion) {
                if (minimatch(currentPath, pattern)) {
                    return [];
                }
            }
        }
        const ret: string[] = [];
        // `depth < 0` means infinite
        if (depth !== 0 && await fse.pathExists(currentPath)) {
            const stat: fse.Stats = await fse.lstat(currentPath);
            if (stat.isDirectory()) {
                const filenames: string[] = await fse.readdir(currentPath);
                for (const filename of filenames) {
                    const filepath: string = path.join(currentPath, filename);
                    const results: string[] = await findAllInDir(filepath, targetFileName, depth - 1, exclusion);
                    for (const result of results) {
                        ret.push(result);
                    }
                }
            } else if (path.basename(currentPath).toLowerCase() === targetFileName) {
                ret.push(currentPath);
            }
        }
        return ret;
    }

    export function getMavenExecutable(): string {
        const mavenPath: string = workspace.getConfiguration("maven.executable").get<string>("path");
        return mavenPath ? `"${mavenPath}"` : "mvn";
    }
}
