import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
try:
    ssh.connect('200.141.1.119', port=22, username='root', password='Xchange4VPS@', timeout=10)
    stdin, stdout, stderr = ssh.exec_command('docker ps')
    print(stdout.read().decode())
    print(stderr.read().decode())
except Exception as e:
    print(f"Error: {e}")
finally:
    ssh.close()
