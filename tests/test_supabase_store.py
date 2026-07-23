import unittest
import sys
import types

import pandas as pd

# Các test helper không cần kết nối Streamlit/Supabase thật.
def _cache_decorator(*args, **kwargs):
    def decorate(func):
        func.clear = lambda: None
        return func

    return decorate


streamlit_stub = types.ModuleType("streamlit")
streamlit_stub.cache_resource = _cache_decorator
streamlit_stub.cache_data = _cache_decorator
streamlit_stub.secrets = {}
supabase_stub = types.ModuleType("supabase")
supabase_stub.create_client = lambda *args, **kwargs: None
sys.modules.setdefault("streamlit", streamlit_stub)
sys.modules.setdefault("supabase", supabase_stub)

import supabase_store


class SupabaseStoreHelpersTest(unittest.TestCase):
    def test_compressed_dataframe_round_trip(self):
        original = pd.DataFrame(
            [{"sku": "00123", "qty": 1.5}, {"sku": "ABC", "qty": 2.0}]
        )

        restored = supabase_store.dataframe_from_payload(
            supabase_store._compress_df(original)
        )

        pd.testing.assert_frame_equal(restored, original)

    def test_reads_legacy_split_payload(self):
        payload = {"columns": ["sku", "qty"], "data": [["A", 2]]}

        restored = supabase_store.dataframe_from_payload(payload)

        self.assertEqual(restored.to_dict("records"), [{"sku": "A", "qty": 2}])

    def test_reads_spa_records_payload(self):
        payload = {"data": [{"sku": "A", "qty": 2}], "_label": "Tháng 07/2026"}

        restored = supabase_store.dataframe_from_payload(payload)

        self.assertEqual(restored.to_dict("records"), [{"sku": "A", "qty": 2}])

    def test_storage_path_removes_parent_segments(self):
        self.assertEqual(
            supabase_store._safe_storage_path("../session 01/../../source.xlsx"),
            "session_01/source.xlsx",
        )

    def test_storage_path_rejects_empty_path(self):
        with self.assertRaises(ValueError):
            supabase_store._safe_storage_path("../../")


if __name__ == "__main__":
    unittest.main()
