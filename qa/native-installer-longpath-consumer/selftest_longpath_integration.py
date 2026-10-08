"""Stdlib synthetic integration checks only; never run an installer or rebuild."""
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prepare_and_package import (FIXTURE_CHECKS, HELPER_COUNT, HELPER_PATHS, HELPER_TREE, child_env,
                                 preserve_supplier_notices, verify_fixture_result, verify_helper_admissions)

ROOT = Path(__file__).resolve().parent
BASE_TREE = 'd37c08c19b1e57ce4829682c4f84ec5fc89bf1fd3c5fc56e0e2b7153f462b4cb'


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='longpath-consumer-synthetic-')
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def write(self, name, value):
        path = self.root / name
        path.write_text(json.dumps(value), encoding='utf-8')
        return path

    def admissions(self):
        baseline = dict(source_tree_sha256=BASE_TREE, source_count=17260, source_only=True,
                        build_performed=False, license_preserved=True, fresh_upstream_reconstruction=True,
                        source_commit='1'*40, upstream_commit='158fd638da1629c8e62caf9ade1515d162def8ab')
        helper = dict(schema=1, base_source_tree_sha256=BASE_TREE, source_tree_sha256=HELPER_TREE,
                      source_count=HELPER_COUNT, license_preserved=True, source_only=True,
                      payload_rebuilt=False, changed_paths=sorted(HELPER_PATHS), helper_source_commit='2'*40)
        pins = dict(source=dict(treeSha256=BASE_TREE, count=17260, commit='3'*40))
        return pins, baseline, helper

    def validate_admissions(self, pins, baseline, helper):
        return verify_helper_admissions(pins, self.write('baseline.json', baseline), self.write('helper.json', helper))

    def test_baseline_and_helper_are_distinct_from_original_payload_commit(self):
        pins, baseline, helper = self.admissions()
        original = copy.deepcopy(pins)
        self.assertEqual(self.validate_admissions(pins, baseline, helper), (baseline, helper))
        self.assertEqual(pins, original)
        self.assertNotEqual(baseline['source_commit'], pins['source']['commit'])

    def test_modified_baseline_cannot_substitute_helper_tree(self):
        pins, baseline, helper = self.admissions()
        baseline['source_tree_sha256'] = HELPER_TREE
        with self.assertRaises(ValueError): self.validate_admissions(pins, baseline, helper)

    def test_wrong_helper_identity_count_or_mutation_claim_fails(self):
        pins, baseline, helper = self.admissions()
        for key, value in [('source_tree_sha256', BASE_TREE), ('source_count', 17260),
                           ('payload_rebuilt', True), ('source_only', False), ('base_source_tree_sha256', '0'*64)]:
            bad = dict(helper, **{key: value})
            with self.subTest(key=key), self.assertRaises(ValueError): self.validate_admissions(pins, baseline, bad)

    def test_extra_or_duplicate_helper_paths_fail(self):
        pins, baseline, helper = self.admissions()
        for paths in [helper['changed_paths'] + ['fixture/unapproved'], helper['changed_paths'] + [helper['changed_paths'][0]]]:
            with self.assertRaises(ValueError): self.validate_admissions(pins, baseline, dict(helper, changed_paths=paths))

    def test_child_environment_keeps_runner_guards_without_secrets(self):
        work, cache = self.root/'work', self.root/'cache'
        work.mkdir(); cache.mkdir()
        original = dict(SystemRoot=str(self.root/'Windows'), GITHUB_ACTIONS='true', RUNNER_TEMP=str(self.root),
                        GITHUB_TOKEN='must-not-propagate', HOME='foreign', PATH='foreign', NPM_CONFIG_USERCONFIG='foreign')
        with patch.dict(os.environ, original, clear=True): result = child_env(work, cache)
        self.assertEqual(result['GITHUB_ACTIONS'], 'true')
        self.assertEqual(result['RUNNER_TEMP'], str(self.root))
        self.assertNotIn('GITHUB_TOKEN', result)
        self.assertNotEqual(result['PATH'], 'foreign')
        self.assertNotEqual(result['HOME'], 'foreign')
        self.assertNotEqual(result['npm_config_userconfig'], result['npm_config_globalconfig'])
        self.assertEqual(Path(result['npm_config_userconfig']).read_bytes(), b'')
        self.assertEqual(Path(result['npm_config_globalconfig']).read_bytes(), b'')

    def fixture(self):
        build = dict(schema=1, fixture_only=True, acceptance_claim=False, payload_unchanged=True,
                     installer_sha256='a'*64, expected=[{'path':'synthetic'}], max_installed_path_characters=400)
        result = dict(schema=1, fixture_only=True, native_windows=True, error=None, forced_cleanup=False,
                      installer_sha256='a'*64, files_verified=1, max_path_characters=400,
                      processes=[dict(label=name, root_exit_code=0, job_empty=True) for name in ('install','junction-refusal','uninstall')],
                      **{key: True for key in FIXTURE_CHECKS})
        return build, result

    def validate_fixture(self, build, result):
        self.write('fixture-build.json', build); self.write('fixture-result.json', result)
        return verify_fixture_result(self.root)

    def test_complete_synthetic_fixture_receipt_is_admitted(self):
        build, result = self.fixture()
        self.assertEqual(self.validate_fixture(build, result), (build, result))

    def test_every_native_fixture_condition_is_required(self):
        build, result = self.fixture()
        for key in FIXTURE_CHECKS:
            with self.subTest(key=key), self.assertRaises(ValueError): self.validate_fixture(build, dict(result, **{key:False}))

    def test_fixture_cannot_claim_success_after_cleanup_or_missing_coverage(self):
        build, result = self.fixture()
        for bad in [dict(result, forced_cleanup=True), dict(result, error='failed'), dict(result, files_verified=0),
                    dict(result, installer_sha256='b'*64), dict(result, max_path_characters=260)]:
            with self.assertRaises(ValueError): self.validate_fixture(build, bad)
        for bad in [dict(build, payload_unchanged=False), dict(build, acceptance_claim=True)]:
            with self.assertRaises(ValueError): self.validate_fixture(bad, result)

    def test_fixture_requires_normally_empty_owned_jobs(self):
        build, result = self.fixture()
        for index in range(3):
            bad = copy.deepcopy(result); bad['processes'][index]['job_empty'] = False
            with self.assertRaises(ValueError): self.validate_fixture(build, bad)
        bad = copy.deepcopy(result); bad['processes'][2]['root_exit_code'] = 2
        with self.assertRaises(ValueError): self.validate_fixture(build, bad)

    def test_overlay_admits_exact_five_helpers_and_one_test(self):
        overlay = json.loads((ROOT/'longpaths/helper-source-overlay.json').read_text())
        self.assertEqual(overlay['base_source_tree_sha256'], BASE_TREE)
        self.assertEqual(overlay['helper_source_tree_sha256'], HELPER_TREE)
        self.assertEqual(overlay['helper_source_count'], HELPER_COUNT)
        self.assertEqual({row['path'] for row in overlay['files']}, HELPER_PATHS)
        self.assertEqual(len(overlay['files']), 6)
        self.assertEqual([row['path'] for row in overlay['files'] if row['path'].endswith('.test.mjs')],
                         ['apps/desktop/scripts/prepared-prepackaged.test.mjs'])
        for row in overlay['files']:
            data = base64.b64decode(row['content_base64'], validate=True)
            self.assertEqual(len(data), row['bytes'])
            self.assertEqual(hashlib.sha256(data).hexdigest(), row['sha256'])
            self.assertNotIn('fixture', row['path'])

    def test_current_fixture_schema_and_complete_adjacent_files(self):
        fixture = ROOT/'longpaths/fixture'
        script = (fixture/'build-native-fixture.mjs').read_text()
        self.assertNotIn('npmRebuild', script)
        self.assertNotIn('nodeGypRebuild', script)
        self.assertEqual(len(json.loads((fixture/'missing-paths.json').read_text())), 32)
        self.assertTrue((fixture/'Test-NativeFixture.ps1').is_file())
        self.assertTrue((fixture/'electron-builder-LICENSE.txt').is_file())

    def test_fresh_tools_precede_fixture_and_fixture_precedes_wrap(self):
        source = (ROOT/'prepare_and_package.py').read_text()
        ordered = ['label="fresh-packaging-preparation"', 'label="tiny-native-longpath-fixture"',
                   'fixture_build, fixture_result = verify_fixture_result', 'label="fresh-custody"',
                   'label="strict-validate-only"', 'label="strict-native-nsis"']
        positions = [source.index(value) for value in ordered]
        self.assertEqual(positions, sorted(positions))
        self.assertIn('fixture_work = work / "fixture"', source)
        self.assertIn('"--publish", "never"', source)

    def test_supplier_notices_are_exact_verified_bytes(self):
        supplier=self.root/'supplier';fixture=self.root/'fixture';output=self.root/'output'
        supplier.mkdir();fixture.mkdir();output.mkdir()
        files={}
        for name in ('LICENSE.txt','COPYING'):
            data=('synthetic notice '+name).encode();(supplier/name).write_bytes(data)
            files[name]=dict(bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
        (fixture/'electron-builder-LICENSE.txt').write_bytes(b'synthetic MIT notice')
        preserve_supplier_notices(dict(supplier=dict(files=files)), dict(toolsets=dict(sevenZip=str(supplier))), fixture, output)
        for name in files:self.assertEqual((output/'installer-supplier-notices'/('7zip-'+name)).read_bytes(),(supplier/name).read_bytes())
        second=self.root/'other-output';second.mkdir();(supplier/'COPYING').write_bytes(b'changed')
        with self.assertRaises(ValueError):preserve_supplier_notices(dict(supplier=dict(files=files)),dict(toolsets=dict(sevenZip=str(supplier))),fixture,second)


if __name__ == '__main__': unittest.main(verbosity=2)
