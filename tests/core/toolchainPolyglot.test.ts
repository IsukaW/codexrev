import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeProject, detectTestCommand, onPath, parseDotnet, planBuildTargets, planModules, planTestCommands } from '../../src/core/toolchains/index.js';
import { runBuildRole } from '../../src/features/review-pipeline/roles/build.js';
import { compareValidation, runValidation } from '../../src/features/review-pipeline/pipeline/fixValidator.js';
import { ContextAggregator } from '../../src/features/review-pipeline/pipeline/contextAggregator.js';
import type { ParsedDiff } from '../../src/features/review-pipeline/pipeline/diffReader.js';
import type { ILLMProvider } from '../../src/features/review-pipeline/pipeline/illmProvider.js';

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-polyglot-')));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(file: string, content = ''): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), content);
}
const diffOf = (files: string[]): ParsedDiff => ({ ref: 'staged', raw: '', files: files.map((p) => ({ path: p, status: 'modified' as const, hunks: [] })) });

const hasDotnet = await onPath('dotnet');
const hasPhp = await onPath('php');

describe('.NET', () => {
  it('parses dotnet build output (captured), relative to the folder it ran in', () => {
    const out = `${root}/src/Shop.Core/Class1.cs(4,67): error CS0103: The name 'pricee' does not exist in the current context [${root}/src/Shop.Core/Shop.Core.csproj]`;
    expect(parseDotnet(out, root)).toEqual([
      { file: 'src/Shop.Core/Class1.cs', line: 4, severity: 'error', code: 'CS0103', message: "The name 'pricee' does not exist in the current context" },
    ]);
  });

  it('builds the solution when there is one, else each project; a project file in a subfolder belongs to its solution', async () => {
    await write('Shop.sln');
    await write('src/Api/Api.csproj', '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
    const [target] = await planBuildTargets(root);
    expect(target).toMatchObject({ label: 'dotnet build', marker: 'Shop.sln' });
    if (hasDotnet) expect(target!.commands[0]).toMatch(/^dotnet build "Shop\.sln" .*-clp:NoSummary/);
    const plan = await planModules(root, ['src/Api/Program.cs']);
    expect(plan.modules.map((m) => m.dir)).toEqual(['.']);
    expect(await describeProject(root)).toBe('C# · .NET 8.0 · ASP.NET Core');
  });

  it('a project with no solution is built on its own, and says so when the SDK is missing', async () => {
    await write('tool/Tool.fsproj', '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>');
    const plan = await planModules(root, ['tool/Program.fs']);
    expect(plan.modules.map((m) => [m.dir, m.targets[0]!.marker])).toEqual([['tool', 'Tool.fsproj']]);
    if (!hasDotnet) expect(plan.modules[0]!.targets[0]!.unavailable).toMatch(/\.NET SDK is not installed/);
    expect(await describeProject(path.join(root, 'tool'))).toBe('F# · .NET 9.0');
  });

  // xunit from the local NuGet cache, so the test needs no network
  const xunitCached = existsSync(path.join(os.homedir(), '.nuget/packages/xunit/2.5.3'));
  async function solution(discount: string): Promise<void> {
    await write('src/Shop.Core/Shop.Core.csproj', '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
    await write('src/Shop.Core/Price.cs', `namespace Shop.Core;\npublic static class Price\n{\n    public static int Discount(int price, int percent) => ${discount};\n}\n`);
    await write(
      'tests/Shop.Tests/Shop.Tests.csproj',
      `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><IsPackable>false</IsPackable></PropertyGroup>
<ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.8.0" /><PackageReference Include="xunit" Version="2.5.3" /><PackageReference Include="xunit.runner.visualstudio" Version="2.5.3" /></ItemGroup>
<ItemGroup><ProjectReference Include="../../src/Shop.Core/Shop.Core.csproj" /></ItemGroup></Project>`,
    );
    await write('tests/Shop.Tests/PriceTest.cs', 'using Shop.Core;\nusing Xunit;\nnamespace Shop.Tests;\npublic class PriceTest\n{\n    [Fact]\n    public void TenPercent() => Assert.Equal(90, Price.Discount(100, 10));\n}\n');
    const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' };
    execFileSync('dotnet', ['new', 'sln', '-n', 'Shop', '-o', '.'], { cwd: root, env, stdio: 'ignore' });
    execFileSync('dotnet', ['sln', 'add', 'src/Shop.Core/Shop.Core.csproj', 'tests/Shop.Tests/Shop.Tests.csproj'], { cwd: root, env, stdio: 'ignore' });
  }
  const llm: ILLMProvider = {
    id: 'openai',
    generate: () => {
      throw new Error('unused');
    },
    stream: () => {
      throw new Error('unused');
    },
  };

  it.skipIf(!hasDotnet || !xunitCached)('Build blocks a C# compile error at the repo-relative file and line, under the sandbox', async () => {
    await solution('pricee');
    const diff = diffOf(['src/Shop.Core/Price.cs']);
    const out = await runBuildRole({ llm, model: 'm', diff, aggregator: new ContextAggregator(diff), cwd: root });
    expect(out.verdict).toBe('block');
    expect(out.findings).toEqual([expect.objectContaining({ file: 'src/Shop.Core/Price.cs', lineStart: 4, severity: 'high', description: expect.stringMatching(/^dotnet build CS0103: The name 'pricee'/) })]);
  }, 300_000);

  it.skipIf(!hasDotnet || !xunitCached)("a change in a library runs the solution's tests, and a behaviour-breaking fix is rejected with xunit's expected/actual", async () => {
    await solution('price - price * percent / 100');
    expect((await planTestCommands(root, ['src/Shop.Core/Price.cs'])).map((t) => [t.dir, t.label])).toEqual([['.', 'dotnet test']]);
    const diff = diffOf(['src/Shop.Core/Price.cs']);
    const baseline = await runValidation(root, diff, { toolchain: { sandbox: true } });
    expect(baseline.tests.status).toBe('pass');
    await write('src/Shop.Core/Price.cs', 'namespace Shop.Core;\npublic static class Price\n{\n    public static int Discount(int price, int percent) => price - percent * 2;\n}\n');
    const verdict = compareValidation(baseline, await runValidation(root, diff, { toolchain: { sandbox: true } }));
    expect(verdict.acceptable).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/Expected: 90[\s\S]*Actual: {3}80/);
  }, 600_000);
});

describe('PHP and Ruby', () => {
  it('Laravel and Rails stack lines', async () => {
    await write('api/composer.json', JSON.stringify({ require: { php: '^8.2', 'laravel/framework': '^11.0' } }));
    await write('shop/Gemfile', "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\n");
    expect(await describeProject(path.join(root, 'api'))).toBe('PHP 8.2 · Laravel 11 · Composer');
    expect(await describeProject(path.join(root, 'shop'))).toBe('Ruby · Rails 7.1');
  });

  it('Rails runs its own test command; plain Ruby with a Rakefile uses rake; rspec wins when there is a spec folder', async () => {
    await write('rails/Gemfile');
    await write('rails/Rakefile');
    await write('rails/test/models/user_test.rb');
    await write('rails/bin/rails');
    await write('gem/Gemfile');
    await write('gem/Rakefile');
    await write('gem/test/a_test.rb');
    await write('spec/Gemfile');
    await write('spec/spec/a_spec.rb');
    expect((await detectTestCommand(path.join(root, 'rails')))?.command).toBe('bin/rails test');
    expect((await detectTestCommand(path.join(root, 'gem')))?.command).toBe('bundle exec rake test');
    expect((await detectTestCommand(path.join(root, 'spec')))?.command).toBe('bundle exec rspec');
  });

  it.skipIf(!hasPhp)('PHPUnit runs when it is configured and installed', async () => {
    await write('composer.json', '{}');
    await write('phpunit.xml.dist');
    await write('vendor/bin/phpunit');
    expect((await detectTestCommand(root))?.command).toBe('php vendor/bin/phpunit');
  });

  it.skipIf(hasPhp)('without PHP installed, no PHP test command is offered (nothing that cannot run)', async () => {
    await write('composer.json', JSON.stringify({ scripts: { test: 'phpunit' } }));
    expect(await detectTestCommand(root)).toBeNull();
  });
});
