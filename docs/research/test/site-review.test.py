import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[3]


class TelemetryAuditTest(unittest.TestCase):
    def test_every_visual_has_a_completed_source_finding(self):
        audit = (ROOT / 'docs/superpowers/specs/2026-10-25-site-review.md').read_text()
        section = audit.split('## Telemetry · every visual accuracy findings')[1].split('\n## ')[0]
        visuals = ['KPI strip', 'Throughput', 'Cycle time', 'Quality and review',
                   'You as CAPCOM', 'Tokens per minute', 'Where agent time goes',
                   'Tokens per turn', 'Tool latency', 'Subagents', 'Quota used',
                   'Machine load', 'Test lock', 'Tokens by ticket',
                   'Tokens by loop step', 'Totals']
        for visual in visuals:
            with self.subTest(visual=visual):
                row = next(line for line in section.splitlines() if line.startswith(f'| {visual} |'))
                self.assertRegex(row, r'\| (Verified|Mismatch|Qualified) — ')
                self.assertIn('`', row)
        for finding in ['counts PRs, not unique tickets', 'wall-time estimate',
                        'ignores Agent/Account/Ticket', 'nearest non-null']:
            self.assertIn(finding, section)
        self.assertNotIn('All rows below need deterministic source records', audit)


if __name__ == '__main__':
    unittest.main()
