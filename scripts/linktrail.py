#!/usr/bin/env python3
"""Compatibility alias (DP-0029): the CRM helper is now agentlinkops.py beside this file."""
import os
import runpy
import sys

sys.stderr.write("linktrail.py: this helper is now agentlinkops.py; the old name keeps working during the pilot compatibility window.\n")
TARGET = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agentlinkops.py")
sys.argv[0] = TARGET
runpy.run_path(TARGET, run_name="__main__")
