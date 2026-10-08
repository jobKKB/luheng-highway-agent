"""Synthetic tests only; no installer or native application invocation."""
from pathlib import Path
import hashlib
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parent))
from inventory_installed import inventory

def row(name,data):return {'path':name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
def manifest(rows):return {'files':rows,'source_commit':'a'*40,'source_tree_sha256':'b'*64}

class InventoryTests(unittest.TestCase):
    def test_equal_keeps_zero_byte_files(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'empty').write_bytes(b'');(root/'nested').mkdir();(root/'nested/x').write_bytes(b'x')
            rows,result=inventory(root,manifest([row('empty',b''),row('nested/x',b'x')]))
            self.assertEqual(len(rows),2);self.assertFalse(result['missing'] or result['added'] or result['changed'] or result['read_errors']);self.assertFalse(result['acceptance_claim'])
    def test_exact_missing_added_and_changed_hashes(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'changed').write_bytes(b'b');(root/'new').write_bytes(b'c')
            _,result=inventory(root,manifest([row('changed',b'a'),row('missing',b'd')]))
            self.assertEqual(result['missing'],[row('missing',b'd')]);self.assertEqual(result['added'],[row('new',b'c')]);self.assertEqual(result['changed'],[{'path':'changed','expected':row('changed',b'a'),'actual':row('changed',b'b')}])
    def test_duplicate_source_fails_closed(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(ValueError,'Duplicate'):
                inventory(Path(d),manifest([row('a',b'a'),row('a',b'a')]))
    def test_missing_root_fails_closed(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(ValueError,'missing'):
                inventory(Path(d)/'missing',manifest([]))
if __name__=='__main__':unittest.main(verbosity=2)
