# frozen_string_literal: true

require "base64"

box_name = ENV.fetch("MIROTALKBRO_RTMP_DEV_BOX", "debian/trixie64")
dev_hostname = ENV.fetch("MIROTALKBRO_RTMP_DEV_HOSTNAME", "mirotalkbro-rtmp-dev")
dev_ip = ENV.fetch("MIROTALKBRO_RTMP_DEV_IP", "192.168.56.5")

PUBLIC_KEY_FILES = %w[
  ~/.ssh/id_ed25519.pub
  ~/.ssh/id_ecdsa.pub
  ~/.ssh/id_rsa.pub
].freeze

PUBLIC_KEY_REGEX = /\A(?<key_type>ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) (?<key_blob>[A-Za-z0-9+\/]+={0,2})(?: (?<comment>[^\r\n[:cntrl:]]{1,1024}))?\z/
PRIVATE_KEY_REGEX = /(?:PRIVATE KEY|-----BEGIN |openssh-key-v1)/i
ROOT_BOOTSTRAP_AUTHORIZED_KEYS_MARKER = "mirotalk-bro-rtmp root bootstrap authorized_keys"

def read_openssh_string!(blob, offset, source)
  if offset + 4 > blob.bytesize
    raise "#{source} has an invalid OpenSSH public key blob"
  end

  length = blob.byteslice(offset, 4).unpack1("N")
  offset += 4

  if length > blob.bytesize - offset
    raise "#{source} has an invalid OpenSSH public key blob"
  end

  [blob.byteslice(offset, length), offset + length]
end

def validate_no_trailing_blob_data!(blob, offset, source)
  return if offset == blob.bytesize

  raise "#{source} has trailing data in the OpenSSH public key blob"
end

def validate_public_key_blob!(declared_type, encoded_blob, source)
  blob = Base64.strict_decode64(encoded_blob)
rescue ArgumentError
  raise "#{source} has invalid base64 in the SSH public key blob"
else
  if blob.bytesize < 8
    raise "#{source} has a too-short OpenSSH public key blob"
  end

  blob_type, offset = read_openssh_string!(blob, 0, source)
  unless blob_type == declared_type.b
    raise "#{source} declares #{declared_type}, but the key blob declares #{blob_type.inspect}"
  end

  case declared_type
  when "ssh-ed25519"
    public_key, offset = read_openssh_string!(blob, offset, source)
    unless public_key.bytesize == 32
      raise "#{source} has an invalid ssh-ed25519 public key length"
    end
  when "ssh-rsa"
    exponent, offset = read_openssh_string!(blob, offset, source)
    modulus, offset = read_openssh_string!(blob, offset, source)
    if exponent.empty? || modulus.empty?
      raise "#{source} has an invalid ssh-rsa public key blob"
    end
  when /\Aecdsa-sha2-nistp(?<bits>256|384|521)\z/
    bits = Regexp.last_match[:bits]
    expected_curve = "nistp#{bits}"
    curve, offset = read_openssh_string!(blob, offset, source)
    unless curve == expected_curve.b
      raise "#{source} declares #{declared_type}, but the ECDSA curve is #{curve.inspect}"
    end

    public_point, offset = read_openssh_string!(blob, offset, source)
    expected_lengths = { "256" => 65, "384" => 97, "521" => 133 }
    unless public_point.getbyte(0) == 4 && public_point.bytesize == expected_lengths.fetch(bits)
      raise "#{source} has an invalid #{declared_type} public point"
    end
  else
    raise "#{source} uses an unsupported SSH public key type"
  end

  validate_no_trailing_blob_data!(blob, offset, source)
end

def validate_public_key!(key, source)
  raw_key = key.to_s

  if raw_key.match?(PRIVATE_KEY_REGEX)
    raise "#{source} must be a single-line SSH public key, not private key material"
  end

  if raw_key.include?("\n") || raw_key.include?("\r") ||
     raw_key.match?(/[[:cntrl:]]/)
    raise "#{source} must be a single-line SSH public key, not private key material or control characters"
  end

  candidate = raw_key.strip

  if candidate.include?("\n") || candidate.include?("\r") ||
     candidate.match?(/[[:cntrl:]]/) || candidate.match?(PRIVATE_KEY_REGEX)
    raise "#{source} must be a single-line SSH public key, not private key material or control characters"
  end

  if candidate.empty?
    raise "#{source} does not contain an SSH public key"
  end

  key_match = candidate.match(PUBLIC_KEY_REGEX)
  unless key_match
    raise "#{source} must be a single-line ssh-ed25519, ssh-rsa, or ecdsa-sha2-nistp* public key"
  end

  validate_public_key_blob!(key_match[:key_type], key_match[:key_blob], source)

  candidate
end

def read_public_key_file(path, required: false)
  expanded_path = File.expand_path(path)

  unless File.file?(expanded_path)
    raise "Public key file #{expanded_path} does not exist" if required

    return nil
  end

  content = File.read(expanded_path, mode: "r:BOM|UTF-8")
  lines = content.lines.map(&:strip).reject(&:empty?)

  if lines.length != 1
    raise "Public key file #{expanded_path} must contain exactly one single-line SSH public key"
  end

  validate_public_key!(lines.first, "Public key file #{expanded_path}")
end

env_public_key_file = ENV["MIROTALKBRO_RTMP_DEV_ROOT_SSH_PUB_KEY_FILE"]
env_public_key = ENV["MIROTALKBRO_RTMP_DEV_ROOT_SSH_PUB_KEY"]
env_public_key_file_set = ENV.key?("MIROTALKBRO_RTMP_DEV_ROOT_SSH_PUB_KEY_FILE")
env_public_key_set = ENV.key?("MIROTALKBRO_RTMP_DEV_ROOT_SSH_PUB_KEY")

dev_root_public_keys = []

if env_public_key_file_set || env_public_key_set
  if env_public_key_file_set && env_public_key_file.to_s.strip.empty?
    raise "MIROTALKBRO_RTMP_DEV_ROOT_SSH_PUB_KEY_FILE must name a public key file when set"
  end

  dev_root_public_keys << read_public_key_file(
    ENV.fetch("MIROTALKBRO_RTMP_DEV_ROOT_SSH_PUB_KEY_FILE"),
    required: true
  ) if env_public_key_file_set

  dev_root_public_keys << validate_public_key!(
    ENV.fetch("MIROTALKBRO_RTMP_DEV_ROOT_SSH_PUB_KEY"),
    "MIROTALKBRO_RTMP_DEV_ROOT_SSH_PUB_KEY"
  ) if env_public_key_set
else
  PUBLIC_KEY_FILES.each do |path|
    key = read_public_key_file(path)
    dev_root_public_keys << key if key
  end
end

dev_root_public_keys.compact!
dev_root_public_keys.uniq!

if dev_root_public_keys.empty?
  raise "No host SSH public key found for root bootstrap. Create ~/.ssh/id_ed25519.pub, ~/.ssh/id_ecdsa.pub, or ~/.ssh/id_rsa.pub, or set MIROTALKBRO_RTMP_DEV_ROOT_SSH_PUB_KEY / MIROTALKBRO_RTMP_DEV_ROOT_SSH_PUB_KEY_FILE to a single-line public key."
end

dev_root_authorized_keys = [
  "# BEGIN #{ROOT_BOOTSTRAP_AUTHORIZED_KEYS_MARKER}",
  *dev_root_public_keys,
  "# END #{ROOT_BOOTSTRAP_AUTHORIZED_KEYS_MARKER}",
  ""
].join("\n")
dev_root_authorized_keys_b64 = Base64.strict_encode64(dev_root_authorized_keys)

if dev_ip && dev_ip !~ /\A(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\z/
  raise "MIROTALKBRO_RTMP_DEV_IP must be a valid IPv4 address"
end

Vagrant.configure("2") do |config|
  config.vm.box = box_name
  config.vm.hostname = dev_hostname
  config.vm.synced_folder ".", "/vagrant", disabled: true

  # Dev-Fast-Track: Repo einseitig (host→VM) per rsync auf die VM synchronisieren,
  # damit `scripts/dev.sh` ohne Host-Docker-CLI und ohne Commits gegen die VM bauen
  # kann. Bewusst zusätzlich zum deaktivierten /vagrant-Mount (Gen-B-Muster bleibt
  # für den Root-Bootstrap unberührt). `vagrant rsync-auto` schreibt Änderungen
  # automatisch fortlaufend.
  # Wichtig: Vagrant rsynct standardmäßig mit --delete; ausgeschlossene Pfade
  # bleiben auf der VM vom Löschen verschont. .env ist deshalb ebenfalls
  # ausgeschlossen (Erzeugung nur auf der VM über `scripts/dev.sh init`), damit
  # der Secret-Transfer des E2E-Tracks nicht bei jedem rsync weggeräumt wird.
  config.vm.synced_folder ".", "/srv/mirotalk-bro-rtmp", type: "rsync",
    rsync__exclude: [".git/", "node_modules/", ".vagrant/", "certs/", "config/keys.json", ".env"]

  config.ssh.insert_key = true
  config.ssh.forward_agent = false

  # Bewusst anderes Subnetz als das vagrant-libvirt-Managementnetz
  # (192.168.121.0/24), damit die private Dev-IP nicht mit Libvirts
  # internem DHCP-Netz kollidiert. Die Dev-IP (192.168.56.5) wurde als
  # freie Adresse im lokalen Dev-Netz gewählt, um Kollisionen mit anderen
  # lokal betriebenen Dev-VMs zu vermeiden. graphics_type wird NICHT
  # überschrieben (Plugin-Default vnc; "none" hängt beim Boot in dieser
  # Nested-KVM-Umgebung).
  config.vm.network "private_network", ip: dev_ip

  config.vm.provider :libvirt do |libvirt|
    libvirt.memory = ENV.fetch("MIROTALKBRO_RTMP_DEV_MEMORY", "4096").to_i
    libvirt.cpus = ENV.fetch("MIROTALKBRO_RTMP_DEV_CPUS", "2").to_i
  end

  config.vm.provision "shell", privileged: true, inline: <<-SHELL
    set -eu

    root_authorized_keys_b64='#{dev_root_authorized_keys_b64}'
    root_bootstrap_begin_marker='# BEGIN #{ROOT_BOOTSTRAP_AUTHORIZED_KEYS_MARKER}'
    root_bootstrap_end_marker='# END #{ROOT_BOOTSTRAP_AUTHORIZED_KEYS_MARKER}'
    root_authorized_keys_path=/root/.ssh/authorized_keys
    root_authorized_keys_tmp=/root/.ssh/authorized_keys.tmp
    root_authorized_keys_next=/root/.ssh/authorized_keys.next

    cleanup_root_authorized_keys_temps() {
      rm -f "$root_authorized_keys_tmp" "$root_authorized_keys_next"
    }
    trap cleanup_root_authorized_keys_temps EXIT

    install -d -m 0700 -o root -g root /root/.ssh
    umask 077
    printf '%s' "$root_authorized_keys_b64" | base64 -d > /root/.ssh/authorized_keys.tmp

    if [ -f "$root_authorized_keys_path" ]; then
      awk \\
        -v begin_marker="$root_bootstrap_begin_marker" \\
        -v end_marker="$root_bootstrap_end_marker" '
          $0 == begin_marker { begin_count++ }
          $0 == end_marker { end_count++ }
          { lines[NR] = $0 }
          END {
            remove_managed_blocks = (begin_count > 0 && begin_count == end_count)
            in_managed_block = 0

            for (line_number = 1; line_number <= NR; line_number++) {
              if (remove_managed_blocks && lines[line_number] == begin_marker) {
                in_managed_block = 1
                next
              }

              if (remove_managed_blocks && lines[line_number] == end_marker) {
                in_managed_block = 0
                next
              }

              if (!in_managed_block) {
                print lines[line_number]
              }
            }
          }
        ' "$root_authorized_keys_path" > "$root_authorized_keys_next"
    else
      : > "$root_authorized_keys_next"
    fi

    if [ -s "$root_authorized_keys_next" ]; then
      printf '\n' >> "$root_authorized_keys_next"
    fi
    cat "$root_authorized_keys_tmp" >> "$root_authorized_keys_next"
    chown root:root "$root_authorized_keys_tmp" "$root_authorized_keys_next"
    chmod 0600 "$root_authorized_keys_tmp" "$root_authorized_keys_next"
    mv "$root_authorized_keys_next" "$root_authorized_keys_path"

    install -d -m 0755 -o root -g root /etc/ssh/sshd_config.d
    cat > /etc/ssh/sshd_config.d/10-mirotalkbrortmp-root-bootstrap.conf <<'EOF'
Port 22
PubkeyAuthentication yes
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF

    if command -v sshd >/dev/null 2>&1; then
      sshd_binary="$(command -v sshd)"
    elif [ -x /usr/sbin/sshd ]; then
      sshd_binary=/usr/sbin/sshd
    else
      echo "sshd binary not found; cannot validate SSH bootstrap configuration" >&2
      exit 1
    fi

    install -d -m 0755 -o root -g root /run/sshd
    "$sshd_binary" -t

    if systemctl reload ssh 2>/dev/null; then
      :
    elif systemctl reload sshd 2>/dev/null; then
      :
    elif systemctl restart ssh 2>/dev/null; then
      :
    else
      systemctl restart sshd
    fi
  SHELL

  # The shell provisioner is for local public-key bootstrap only. For a
  # hardened setup, optionally apply your own host-hardening baseline first
  # and adapt inventory/dev.yml accordingly (hardened user, SSH port,
  # become: true). The bootstrap marker block can then be removed manually
  # from /root/.ssh/authorized_keys.
end
