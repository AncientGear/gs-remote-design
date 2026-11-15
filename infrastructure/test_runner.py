import pathlib
import subprocess
import unittest

ROOT = pathlib.Path(__file__).parent


class RunnerTests(unittest.TestCase):
    def test_help_has_no_side_effects(self):
        result = subprocess.run(['bash', str(ROOT / 'smoke.sh'), '--help'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('ahau-2026', result.stdout)
        self.assertIn('destroy', result.stdout)
        self.assertEqual(result.stderr, '')

    def test_unknown_argument_rejected(self):
        result = subprocess.run(['bash', str(ROOT / 'smoke.sh'), '--bad'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, '')
        self.assertIn('Unknown argument', result.stderr)


if __name__ == '__main__':
    unittest.main()
