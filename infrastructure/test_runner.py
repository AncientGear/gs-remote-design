import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).parent


class RunnerTests(unittest.TestCase):
    def test_help_has_no_side_effects(self):
        result = subprocess.run(['bash', str(ROOT / 'smoke.sh'), '--help'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('ahau-2026', result.stdout)
        self.assertIn('destroy', result.stdout)
        self.assertEqual(result.stderr, '')

    def test_stalled_evidence_still_destroys_and_preserves_exit(self):
        source = (ROOT / 'smoke.sh').read_text()
        cleanup = source.split('cleanup() {', 1)[1].split('\ntrap cleanup EXIT', 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            run = pathlib.Path(directory)
            tools = {
                'ssh': 'exec sleep 10\n',
                'terraform': 'printf "%s\\n" "$*" >>"$run/calls"\n',
                # Exercise real GNU timeout with short test-only deadlines.
                'timeout': f'exec {shutil.which("timeout")} --kill-after=0.1s 0.1s "${{@:3}}"\n',
            }
            for name, body in tools.items():
                tool = run / name
                tool.write_text('#!/bin/bash\n' + body)
                tool.chmod(0o700)
            script = ('set -Eeuo pipefail\ncleanup() {' + cleanup +
                      '\ntrap cleanup EXIT\nmanaged=1\nip=192.0.2.1\nssh_opts=()\nexit 7\n')
            result = subprocess.run(
                ['bash', '-c', script], capture_output=True, text=True, timeout=3,
                env={**os.environ, 'PATH': f'{run}:{os.environ["PATH"]}', 'run': str(run)},
            )
            self.assertEqual(result.returncode, 7, result.stderr)
            self.assertEqual(result.stdout, 'Cleanup confirmed: Terraform manages zero resources\n')
            self.assertEqual(result.stderr, '')
            self.assertEqual((run / 'calls').read_text(),
                             f'-chdir={run} destroy -auto-approve -input=false -no-color\n'
                             f'-chdir={run} state list\n')
            self.assertEqual((run / 'remaining-state.txt').read_text(), '')

    def test_unknown_argument_rejected(self):
        result = subprocess.run(['bash', str(ROOT / 'smoke.sh'), '--bad'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, '')
        self.assertIn('Unknown argument', result.stderr)


if __name__ == '__main__':
    unittest.main()
