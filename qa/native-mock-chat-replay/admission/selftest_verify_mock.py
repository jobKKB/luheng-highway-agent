"""Synthetic fail-closed unit tests. Never download, build, install or launch a product."""
from __future__ import annotations
import copy
import hashlib
import json
from pathlib import Path
import runpy
import tempfile
import unittest

V = runpy.run_path(str(Path(__file__).with_name('verify_mock.py')))
BASE = Path(__file__).with_name('contract.json')
PINS = V['contract'](BASE)
H = lambda b: hashlib.sha256(b).hexdigest()
NEGATIVE_CASES = 0


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding='utf-8')


def fails(call):
    global NEGATIVE_CASES
    try:
        call()
    except (ValueError, KeyError, TypeError, OSError):
        NEGATIVE_CASES += 1
        return
    raise AssertionError('Fail-closed guard accepted altered input')


class Fixture:
    def __init__(self, root):
        self.root = Path(root)
        self.pins = copy.deepcopy(PINS)
        self.evidence = self.root / 'original'
        self.evidence.mkdir()
        self.source = self.pins['source']
        self.contents = {'LuhengOfficeAgent.exe': b'MZsynthetic-desktop', 'resources/app.asar': b'synthetic-asar'}
        self.generated = {'Uninstall LuhengOfficeAgent.exe': b'MZsynthetic-uninstaller', 'resources/package-type': b'nsis'}
        self.pins['generatedInstallerFiles'] = [dict(path=k, bytes=len(v), sha256=H(v)) for k,v in self.generated.items()]
        self.pins['payload'] = {'files': len(self.contents), 'bytes': sum(map(len,self.contents.values()))}
        self.installer = self.root / self.pins['installer']['path']
        self.installer.write_bytes(b'MZsynthetic-NSIS')
        self.pins['installer'].update(bytes=self.installer.stat().st_size,sha256=H(self.installer.read_bytes()),
            exeSha256=H(self.contents['LuhengOfficeAgent.exe']),asarSha256=H(self.contents['resources/app.asar']))
        source = {'source_commit': self.source['commit'], 'source_tree_sha256': self.source['treeSha256'], 'source_count': self.source['count']}
        self.admission = {**source,'source_only':True,'license_preserved':True,'build_performed':False,'fresh_upstream_reconstruction':True}
        self.manifest = {**source,'schema':2,'target':'win32-x64','base_version':'0.7.1',
            'artifact_kind':'official-prepared-unpacked-Windows-x64-build-only','desktop_and_embedded_cli_stamp_match':True,
            'production_update_enabled':True,'update_mechanism':'electron-updater',
            'update_stamp':{'source':'commit-build','payload':'bundled','distribution':'desktop-app','dirty':False,
                'commit':self.source['commit'],'baseVersion':'0.7.1','channelBuild':None,'updateMechanism':'electron-updater',
                'desktopReleasePolicy':copy.deepcopy(V['UPDATE_POLICY'])},
            'update_configuration':{'provider':'generic','url':V['UPDATE_POLICY']['publicBase']+'/',
                'channel':'latest','updaterCacheDirName':'luhengofficeagent-updater'},
            'files':[dict(path=k,bytes=len(v),sha256=H(v)) for k,v in self.contents.items()]}
        self.health = {k:True for k in ['native_windows','plain_launch','contained_backend_health','normal_window_close']}
        self.health.update(architecture='X64',error=None,forced_cleanup=False,build_run_id=str(PINS['build']['runId']),health_version='0.7.1')
        self.life = {k:True for k in V['LIFECYCLE_TRUE']}
        self.life.update({k:False for k in V['LIMITS_FALSE']})
        token = {'UserSid':'S-1-5-21-123-500','IntegritySid':'S-1-16-8192','IsElevated':0,'HasRestrictions':1}
        self.life.update(schema=1,error=None,forced_cleanup=False,build_run_id=PINS['build']['runId'],
            consumer_run_id=str(PINS['build']['runId']),acceptance_run_id=str(PINS['build']['runId']),scope='same-job',
            installer_sha256=self.pins['installer']['sha256'],health_version='0.7.1',architecture='X64',
            immutable_payload_rebuilt=False,unsigned_installer=True,coverage='restricted-token-same-user',
            restricted_token_lifecycle_verified=True,runner_token=token,
            tokens={name:copy.deepcopy(token) for name in ['installer','desktop','backend','uninstaller']})
        self.build = {'schema':1,'installer':'D:/original/'+self.installer.name,'bytes':self.pins['installer']['bytes'],
            'sha256':self.pins['installer']['sha256'],'signed':False,'payload':{'sourceCommit':self.source['commit'],
            'sourceTreeSha256':self.source['treeSha256'],'sourceCount':self.source['count'],'baseVersion':'0.7.1',
            'fileCount':2,'rebuilt':False},'custody':{'runId':str(PINS['build']['runId'])}}
        self.docs={'sourceAdmission':self.admission,'structure':self.manifest,'health':self.health,
            'installerReceipt':self.build,'lifecycle':self.life}
        self.sync()

    def sync(self):
        for key,value in self.docs.items():
            if key!='installerReceipt': self.pin(key,value)
        self.build['custody'].update(manifestSha256=self.pins['evidenceFiles']['structure']['sha256'],
            nativeHealthSha256=self.pins['evidenceFiles']['health']['sha256'])
        self.pin('installerReceipt',self.build)

    def pin(self,key,value):
        p=self.evidence/self.pins['evidenceFiles'][key]['path']
        write(p,value)
        self.pins['evidenceFiles'][key].update(bytes=p.stat().st_size,sha256=H(p.read_bytes()))

    def install_tree(self):
        tree=self.root/'install'
        for name,content in {**self.contents,**self.generated}.items():
            p=tree/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(content)
        return tree

    def new_acceptance(self):
        out=self.root/'current';out.mkdir()
        life=copy.deepcopy(self.life)
        life.update(coverage='elevated-runner-explicitly-limited',restricted_token_lifecycle_verified=False,
            consumer_run_id='999',debugger_owned_loopback=True,mocked_model_orchestration_verified=True,
            mock_controller_closed=True,plain_launch=False,model_chat_verified=False,
            ui_probe_mode='fresh-synthetic-profile-loopback-cdp-mock-chat')
        life.pop('scope');life.pop('acceptance_run_id')
        life['runner_token'].update(IsElevated=1,IntegritySid='S-1-16-12288',HasRestrictions=0)
        for token in life['tokens'].values():token.update(IsElevated=1,IntegritySid='S-1-16-12288',HasRestrictions=0)
        life['tokens']['mock-controller']=copy.deepcopy(life['runner_token'])
        write(out/'installer-lifecycle.json',life)
        tree={'every_payload_file_sha256_verified':True,'exact_membership':True,
            'payload_files':2,'payload_bytes':self.pins['payload']['bytes'],'source_commit':self.source['commit'],
            'source_tree_sha256':self.source['treeSha256'],'rebuilt':False,'generated_installer_files':self.pins['generatedInstallerFiles']}
        for name in ['installed-payload-before-launch.json','installed-payload-after-exit.json']:write(out/name,tree)
        mock={'schema':1,'kind':'mocked-model-orchestration','installer_sha256':self.pins['installer']['sha256'],
            'accepted_with_declared_limits':True,'error':None}
        mock.update({k:True for k in ['title_generation_disabled','synthetic_key_only','local_model_request_verified',
            'real_read_file_roundtrip_verified','assistant_reply_rendered','marker_file_unchanged']})
        mock.update({k:False for k in ['real_provider_verified','llm_quality_verified','offline_verified','physical_ime_verified','os_network_settings_changed']})
        write(out/'mock-chat.json',mock)
        return out,life,mock,tree


class AdmissionTests(unittest.TestCase):
    def test_contract_exact_frozen_pins(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'contract.json'
            for group in ['build','source','installer','release','evidenceArtifact','evidenceFiles','payload']:
                for field in PINS[group]:
                    changed=copy.deepcopy(PINS)
                    changed[group][field]='changed'
                    write(path,changed)
                    with self.subTest(group=group,field=field):fails(lambda:V['contract'](path))
            for field,value in [('qualified',False),('schema',True),('lifecycleMode','restricted-token-same-user'),
                ('priorLifecycleMode','elevated-runner-explicitly-limited'),('minimumScratchBytes',1),('minimumScratchBytes',1e30),
                ('generatedInstallerFiles',[]),('reviewedController','0'*40),('repository','elsewhere/repo')]:
                changed=copy.deepcopy(PINS);changed[field]=value;write(path,changed)
                with self.subTest(field=field):fails(lambda:V['contract'](path))

    def test_json_and_path_aliases(self):
        for name in ['../escape','/absolute','C:/drive','a\\b','a//b','a/./b','a/../b','NUL.txt','COM1.exe',
                     'LPT².bin','a.','a ','a:b','a\x00b','a?b','CONIN$','resources/../outside']:
            with self.subTest(name=repr(name)):fails(lambda:V['safe_name'](name))
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)/'a.json'
            for data in ['{"a":1,"a":2}','{"n":NaN}','{"n":Infinity}']:
                p.write_text(data);fails(lambda:V['read_json'](p))

    def test_exact_api_mutations(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            api=V['API'];b=PINS['build'];a=PINS['evidenceArtifact'];r=PINS['release'];i=PINS['installer']
            run={'id':b['runId'],'head_sha':b['head'],'run_attempt':b['runAttempt'],'path':b['workflowPath'],
                 'status':'completed','conclusion':'success','repository':{'id':1400818714,'full_name':PINS['repository']},
                 'head_repository':{'id':1400818714,'full_name':PINS['repository']},'url':api+'/actions/runs/'+str(b['runId'])}
            artifact={'id':a['id'],'name':a['name'],'size_in_bytes':a['bytes'],'digest':a['digest'],'expired':False,
                'url':api+'/actions/artifacts/'+str(a['id']),'archive_download_url':api+'/actions/artifacts/'+str(a['id'])+'/zip',
                'workflow_run':{'id':b['runId'],'head_sha':b['head'],'repository_id':1400818714,'head_repository_id':1400818714}}
            release={'id':r['id'],'tag_name':r['tag'],'draft':False,'prerelease':True,'target_commitish':b['head'],
                'url':api+'/releases/'+str(r['id']),'assets':[{'id':r['assetId'],'name':r['assetName'],'state':'uploaded',
                'size':i['bytes'],'digest':'sha256:'+i['sha256'],'browser_download_url':i['url'],
                'url':api+'/releases/assets/'+str(r['assetId'])}]}
            originals={'producer-run.json':run,'evidence-artifact.json':artifact,'release.json':release}
            for name,v in originals.items():write(root/name,v)
            self.assertTrue(V['verify_api'](PINS,root)['api_admission_passed'])
            cases=[('producer-run.json','id',1),('producer-run.json','head_sha','0'*40),
                ('producer-run.json','run_attempt',2),('producer-run.json','conclusion','failure'),
                ('producer-run.json','status','in_progress'),('producer-run.json','path','other.yml'),
                ('evidence-artifact.json','id',1),('evidence-artifact.json','expired',True),
                ('evidence-artifact.json','digest','sha256:'+'0'*64),('evidence-artifact.json','size_in_bytes',1),
                ('evidence-artifact.json','name','wrong'),('release.json','tag_name','v0.7.0-beta.1'),
                ('release.json','target_commitish','0'*40),('release.json','draft',True),('release.json','prerelease',False)]
            for name,key,value in cases:
                altered=copy.deepcopy(originals[name]);altered[key]=value;write(root/name,altered)
                with self.subTest(name=name,key=key):fails(lambda:V['verify_api'](PINS,root))
                write(root/name,originals[name])
            for key,value in [('id',1),('name','wrong.exe'),('state','new'),('size',1),('digest','sha256:'+'0'*64),
                              ('browser_download_url','https://example.com/installer.exe')]:
                altered=copy.deepcopy(originals['release.json']);altered['assets'][0][key]=value
                write(root/'release.json',altered)
                with self.subTest(asset=key):fails(lambda:V['verify_api'](PINS,root))
            altered=copy.deepcopy(originals['release.json']);altered['assets'].append(altered['assets'][0])
            write(root/'release.json',altered);fails(lambda:V['verify_api'](PINS,root))
            write(root/'release.json',originals['release.json'])
            altered=copy.deepcopy(originals['evidence-artifact.json']);altered['workflow_run']['head_sha']='0'*40
            write(root/'evidence-artifact.json',altered);fails(lambda:V['verify_api'](PINS,root))

    def test_tiny_evidence_and_semantic_repin_rejection(self):
        changes=[('sourceAdmission','source_tree_sha256','0'*64),('sourceAdmission','source_only',False),
            ('sourceAdmission','license_preserved',False),('sourceAdmission','build_performed',True),
            ('structure','production_update_enabled',False),('structure','base_version','0.7.0'),
            ('structure','source_count',1),('structure','target','linux-x64'),
            ('health','plain_launch',False),('health','forced_cleanup',True),('health','health_version','0.7.0'),
            ('health','error','failure'),('installerReceipt','signed',True),('installerReceipt','sha256','0'*64),
            ('lifecycle','coverage','elevated-runner-explicitly-limited'),('lifecycle','forced_cleanup',True),
            ('lifecycle','error','failure'),('lifecycle','health_version','0.7.0'),
            ('lifecycle','restricted_token_lifecycle_verified',False),('lifecycle','normal_uninstall',False),
            ('lifecycle','immutable_payload_rebuilt',True),('lifecycle','standard_user_installation_verified',True)]
        for name,key,value in changes:
            with self.subTest(name=name,key=key),tempfile.TemporaryDirectory() as temp:
                f=Fixture(temp);self.assertTrue(V['verify_evidence'](f.pins,f.evidence)['frozen_evidence_admission_passed'])
                f.docs[name][key]=value;f.sync()
                fails(lambda:V['verify_evidence'](f.pins,f.evidence))
        with tempfile.TemporaryDirectory() as temp:
            f=Fixture(temp);path=f.evidence/f.pins['evidenceFiles']['health']['path'];path.write_text('{}')
            fails(lambda:V['verify_evidence'](f.pins,f.evidence))

    def test_source_policy_token_and_inventory_boundaries(self):
        mutations=[lambda f:f.manifest['update_stamp']['desktopReleasePolicy'].update(enabled=False),
            lambda f:f.manifest['update_stamp']['desktopReleasePolicy'].update(windowsMode='production'),
            lambda f:f.manifest['update_configuration'].update(url='https://example.com/'),
            lambda f:f.manifest['update_stamp'].update(commit='0'*40),
            lambda f:f.manifest['files'].append(dict(f.manifest['files'][0])),
            lambda f:f.manifest['files'][0].update(path='../escape'),
            lambda f:f.manifest['files'][0].update(bytes=True),
            lambda f:f.life['tokens']['desktop'].update(IsElevated=1),
            lambda f:f.life['tokens']['backend'].update(UserSid='S-1-5-21-other'),
            lambda f:f.life['runner_token'].update(HasRestrictions=0),
            lambda f:f.build['payload'].update(rebuilt=True),lambda f:f.build['payload'].update(fileCount=1)]
        for index,mutate in enumerate(mutations):
            with self.subTest(index=index),tempfile.TemporaryDirectory() as temp:
                f=Fixture(temp);mutate(f);f.sync();fails(lambda:V['verify_evidence'](f.pins,f.evidence))

    def test_installed_tree_and_generated_files(self):
        def check(f,root):return V['verify_tree'](f.pins,root,f.manifest,'Uninstall LuhengOfficeAgent.exe')
        with tempfile.TemporaryDirectory() as temp:
            f=Fixture(temp);root=f.install_tree();self.assertTrue(check(f,root)['exact_membership'])
            (root/'ordinary-empty-directory').mkdir()
            self.assertTrue(check(f,root)['exact_membership'])
            fails(lambda:V['verify_tree'](f.pins,root,f.manifest,'other.exe'))
        changes=[lambda r:(r/'LuhengOfficeAgent.exe').write_bytes(b'changed'),
                 lambda r:(r/'resources/app.asar').unlink(),lambda r:(r/'unexpected').write_bytes(b'extra'),
                 lambda r:(r/'Uninstall LuhengOfficeAgent.exe').write_bytes(b'MZother'),
                 lambda r:(r/'resources/package-type').write_bytes(b'zip!'),
                 # Remove first so case-insensitive Windows cannot turn this into a no-op overwrite.
                 lambda r:((r/'resources/app.asar').unlink(), (r/'resources/App.asar').write_bytes(b'synthetic-asar'))]
        for index,change in enumerate(changes):
            with self.subTest(index=index),tempfile.TemporaryDirectory() as temp:
                f=Fixture(temp);root=f.install_tree();change(root);fails(lambda:check(f,root))
        with tempfile.TemporaryDirectory() as temp:
            f=Fixture(temp);root=f.install_tree();p=root/'resources/app.asar';content=p.read_bytes();p.unlink()
            outside=Path(temp)/'outside';outside.write_bytes(content);p.symlink_to(outside)
            fails(lambda:check(f,root))
        with tempfile.TemporaryDirectory() as temp:
            f=Fixture(temp);root=f.install_tree();alias=Path(temp)/'alias';alias.symlink_to(root,target_is_directory=True)
            fails(lambda:check(f,alias))
        with tempfile.TemporaryDirectory() as temp:
            import os
            f=Fixture(temp);root=f.install_tree();p=root/'resources/app.asar';outside=Path(temp)/'hardlink';os.link(p,outside)
            fails(lambda:check(f,root))

    def test_download_relocation_preserves_original(self):
        with tempfile.TemporaryDirectory() as temp:
            f=Fixture(temp);original=f.evidence/f.pins['evidenceFiles']['installerReceipt']['path'];before=original.read_bytes()
            relocated=Path(temp)/'output/installer-build.relocated.json'
            result=V['verify_downloads'](f.pins,f.evidence,f.installer,relocated)
            self.assertTrue(result['download_admission_passed']);self.assertEqual(before,original.read_bytes())
            after=V['read_json'](relocated);self.assertEqual(after.pop('installer'),str(f.installer.absolute()))
            expected=copy.deepcopy(f.build);expected.pop('installer');self.assertEqual(after,expected)
            fails(lambda:V['verify_downloads'](f.pins,f.evidence,f.installer,relocated))
            fails(lambda:V['verify_downloads'](f.pins,f.evidence,f.installer,f.evidence/'relocated.json'))
            f.installer.write_bytes(b'MZchanged');fails(lambda:V['verify_downloads'](f.pins,f.evidence,f.installer,Path(temp)/'other.json'))
            self.assertEqual(before,original.read_bytes())

    def test_new_acceptance_does_not_borrow_prior_scope(self):
        fields=[(k,False) for k in [*V['LIFECYCLE_TRUE'],'debugger_owned_loopback','mocked_model_orchestration_verified','mock_controller_closed']]
        fields += [(k,True) for k in [*V['LIMITS_FALSE'],'forced_cleanup','immutable_payload_rebuilt','plain_launch','model_chat_verified','restricted_token_lifecycle_verified']]
        fields += [('consumer_run_id','998'),('installer_sha256','0'*64),('build_run_id',1),('error','failure'),
                   ('coverage','restricted-token-same-user'),('ui_probe_mode','plain-launch')]
        for key,value in fields:
            with self.subTest(key=key),tempfile.TemporaryDirectory() as temp:
                f=Fixture(temp);out,life,mock,tree=f.new_acceptance()
                self.assertTrue(V['verify_acceptance'](f.pins,f.evidence,out,'999')['base_lifecycle_only'])
                life[key]=value;write(out/'installer-lifecycle.json',life)
                fails(lambda:V['verify_acceptance'](f.pins,f.evidence,out,'999'))
        with tempfile.TemporaryDirectory() as temp:
            f=Fixture(temp);out,life,mock,tree=f.new_acceptance()
            fails(lambda:V['verify_acceptance'](f.pins,f.evidence,out,'998'))
            tree['generated_installer_files'][0]['sha256']='0'*64
            # Copy before mutation: fixture tree otherwise shares contract generated rows.
            f.pins['generatedInstallerFiles'][0]['sha256']=H(f.generated['Uninstall LuhengOfficeAgent.exe'])
            changed=copy.deepcopy(tree);changed['generated_installer_files'][0]['sha256']='0'*64
            write(out/'installed-payload-after-exit.json',changed)
            fails(lambda:V['verify_acceptance'](f.pins,f.evidence,out,'999'))
        for key,value in [('accepted_with_declared_limits',False),('real_provider_verified',True),('error','bad'),('local_model_request_verified',False)]:
            with self.subTest(mock=key),tempfile.TemporaryDirectory() as temp:
                f=Fixture(temp);out,life,mock,tree=f.new_acceptance();mock[key]=value;write(out/'mock-chat.json',mock)
                fails(lambda:V['verify_acceptance'](f.pins,f.evidence,out,'999'))
        with tempfile.TemporaryDirectory() as temp:
            f=Fixture(temp);out,life,mock,tree=f.new_acceptance()
            life['tokens']['mock-controller']['UserSid']='S-1-5-21-other'
            write(out/'installer-lifecycle.json',life)
            fails(lambda:V['verify_acceptance'](f.pins,f.evidence,out,'999'))

    def test_manifest_directory_case_aliases(self):
        for rows in [
            [{'path':'a/f','bytes':0,'sha256':H(b'')},{'path':'A/g','bytes':0,'sha256':H(b'')}],
            [{'path':'a','bytes':0,'sha256':H(b'')},{'path':'a/g','bytes':0,'sha256':H(b'')}],
            [{'path':'a','bytes':0,'sha256':H(b'')},{'path':'A','bytes':0,'sha256':H(b'')}],
            []]:fails(lambda:V['inventory']({'files':rows}))

    def test_cli_freshness_and_failed_checks_do_not_mint_receipts(self):
        import subprocess
        import sys
        verifier=Path(__file__).with_name('verify_mock.py')
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);output=root/'result.json'
            command=[sys.executable,'-I','-S','-B',str(verifier),'contract','--contract',str(BASE),'--output',str(output)]
            first=subprocess.run(command,capture_output=True,text=True)
            self.assertEqual(first.returncode,0,first.stderr)
            original=output.read_bytes()
            second=subprocess.run(command,capture_output=True,text=True)
            self.assertNotEqual(second.returncode,0)
            self.assertEqual(output.read_bytes(),original)
            bad=root/'bad.json';write(bad,{**PINS,'qualified':False})
            failed=root/'failed.json'
            denied=subprocess.run([sys.executable,'-I','-S','-B',str(verifier),'contract','--contract',str(bad),
                                  '--output',str(failed)],capture_output=True,text=True)
            self.assertNotEqual(denied.returncode,0)
            self.assertFalse(failed.exists())
            for mode in ['api','evidence','downloads','tree','acceptance']:
                with self.subTest(mode=mode):
                    p=subprocess.run([sys.executable,'-I','-S','-B',str(verifier),mode,'--contract',str(BASE),
                                      '--output',str(failed)],capture_output=True,text=True)
                    self.assertNotEqual(p.returncode,0)
                    self.assertFalse(failed.exists())


if __name__=='__main__':
    result=unittest.main(verbosity=2,exit=False).result
    print(json.dumps({'synthetic_only':True,'suites':result.testsRun,'rejected_negative_cases':NEGATIVE_CASES,
                      'passed':result.wasSuccessful(),'native_execution_performed':False}))
    raise SystemExit(0 if result.wasSuccessful() else 1)
