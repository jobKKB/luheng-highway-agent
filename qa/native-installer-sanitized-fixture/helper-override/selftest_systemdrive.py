"""Synthetic SystemDrive regression; does not launch packaging or change OS state."""
from pathlib import Path
import os
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
from prepare_and_package import child_env, windows_system_drive

class SystemDriveTests(unittest.TestCase):
    def test_missing_inherited_drive_is_derived(self):
        self.assertEqual(windows_system_drive(r'C:\Windows'), 'C:')
        self.assertEqual(windows_system_drive(r'D:\Windows'), 'D:')
    def test_matching_inherited_drive_is_case_insensitive(self):
        self.assertEqual(windows_system_drive(r'c:\Windows','C:'), 'C:')
        self.assertEqual(windows_system_drive('C:/Windows','c:'), 'C:')
    def test_conflicting_or_unresolved_inherited_drive_is_rejected(self):
        for value in ('D:', '', '%SystemDrive%', 'C:\\'):
            with self.subTest(value=value), self.assertRaises(ValueError): windows_system_drive(r'C:\Windows',value)
    def test_relative_unc_or_unresolved_system_root_is_rejected(self):
        for value in ('Windows',r'C:Windows',r'\Windows',r'\\server\Windows',r'%SystemDrive%\Windows',r'C:\%windir%'):
            with self.subTest(value=value), self.assertRaises(ValueError): windows_system_drive(value)
    def test_child_environment_uses_os_drive_not_inherited_home_drive(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);work=root/'work';cache=root/'cache';work.mkdir();cache.mkdir()
            with patch.dict(os.environ, {'SystemRoot':r'C:\Windows','HOMEDRIVE':'D:',
                'USERPROFILE':r'D:\synthetic-user','GITHUB_ACTIONS':'true','RUNNER_TEMP':str(root),
                'GITHUB_TOKEN':'must-not-propagate'},clear=True):
                env=child_env(work,cache)
            self.assertEqual(env['SystemDrive'],'C:')
            self.assertEqual(env['GITHUB_ACTIONS'],'true')
            self.assertNotIn('GITHUB_TOKEN',env)
            self.assertNotIn('%SystemDrive%',env['SystemDrive'])
    def test_supplied_system_drive_is_validated_in_actual_child_env(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);work=root/'work';cache=root/'cache';work.mkdir();cache.mkdir()
            with patch.dict(os.environ, {'SystemRoot':r'C:\Windows','SystemDrive':'D:'},clear=True):
                with self.assertRaises(ValueError):child_env(work,cache)
            self.assertEqual(list(work.iterdir()),[])

if __name__=='__main__':unittest.main(verbosity=2)
