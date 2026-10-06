import fs from 'node:fs';
import cp from 'node:child_process';

const files = ['docs/KNOWN-ISSUES.md', 'README.md'];
const regex = /fixed in branch ([\`\w\-]+) \((commit [a-f0-9]+(?:, commit [a-f0-9]+)?)\), not deployed/g;

let totalReplacements = 0;

for (const filePath of files) {
  if (!fs.existsSync(filePath)) continue;
  const original = fs.readFileSync(filePath, 'utf8');
  let fileReplacements = 0;
  
  const updated = original.replace(regex, (_match, branch, commit) => {
    fileReplacements++;
    totalReplacements++;
    return `fixed in main (originally branch ${branch}, ${commit}), not yet deployed to the public servers`;
  });
  
  if (fileReplacements > 0) {
    fs.writeFileSync(filePath, updated, 'utf8');
  }
  console.log(`${filePath}: ${fileReplacements} replacements`);
}

console.log(`Total replacements: ${totalReplacements}`);

// Show first 5 diff lines from git diff
const diffOutput = cp.execSync('git diff docs/KNOWN-ISSUES.md README.md', { encoding: 'utf8' });
const diffLines = diffOutput.split('\n');
console.log('First 5 diff lines:');
diffLines.slice(0, 5).forEach((line) => console.log(line));
