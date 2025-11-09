# AppArmor profile sample for tool worker

profile tool-worker /usr/bin/node {
  # Deny network
  network deny,

  # Allow basic file I/O within confined directories
  # Replace <TOOL_DIR> with actual allowed directories
  /var/lib/tools/** rw,
  /var/tmp/** rw,

  # Read-only for binaries and libs
  /usr/bin/node rix,
  /usr/lib/** mr,

  # Deny exec outside node
  deny /** x,
}

